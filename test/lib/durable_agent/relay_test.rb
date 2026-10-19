require "test_helper"

class DurableAgent::RelayTest < ActiveSupport::TestCase
  setup do
    @relay = DurableAgent::Relay.new
    @callbacks = [ :@on_mirror, :@on_report ].map { DurableAgent.config.instance_variable_get(it) }
  end

  teardown do
    DurableAgent.config.on_mirror, DurableAgent.config.on_report = @callbacks
  end

  test "a mirrored frame refreshes the conversation by default" do
    conversation = durable_agent_conversations(:idle)
    streams = capture_turbo_stream_broadcasts(conversation) do
      @relay.handle("durable_agent_mirror", %({"conversationId": #{conversation.id}, "entries": [900101], "docs": ["pi.live"]}))
    end
    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "on_mirror receives the conversation, its new entries, the doc kinds and the settled submission" do
    received = nil
    DurableAgent.config.on_mirror = ->(conversation, **frame) { received = [ conversation, frame ] }

    @relay.handle("durable_agent_mirror", { "conversationId" => 900001, "entries" => [ 900102, 900101 ], "docs" => [ "pi.live" ] })
    conversation, frame = received
    assert_equal durable_agent_conversations(:idle), conversation
    assert_equal [ durable_agent_entries(:question), durable_agent_entries(:answer_with_tool) ], frame[:entries]
    assert_equal [ "pi.live" ], frame[:docs]
    assert_nil frame[:submission]

    @relay.handle("durable_agent_mirror", { "conversationId" => 900001, "submission" => { "id" => 900401, "status" => "done" } })
    assert_equal [], received.last[:entries]
    assert_equal [], received.last[:docs]
    assert_equal durable_agent_submissions(:answered), received.last[:submission]
  end

  test "a report refreshes its conversation by default" do
    conversation = durable_agent_conversations(:busy)
    report_id = insert_report(conversation_id: conversation.id)

    streams = capture_turbo_stream_broadcasts(conversation) do
      @relay.handle("durable_agent_reports", { "id" => report_id, "type" => "task_faulted", "conversationId" => conversation.id })
    end
    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "a report without a conversation reaches on_report and broadcasts nothing by default" do
    report_id = insert_report(conversation_id: nil)
    assert_nothing_raised { @relay.handle("durable_agent_reports", { "id" => report_id }) }

    received = nil
    DurableAgent.config.on_report = ->(report) { received = report }
    @relay.handle("durable_agent_reports", { "id" => report_id })
    assert_equal "boom", received.message
  end

  test "other channels are ignored" do
    assert_nil @relay.handle("elsewhere", {})
  end

  test "a dropped connection is discarded, reconnected and LISTENed again, and delivery continues" do
    received = capture_mirrors
    pool = FakePool.new(
      FakeRaw.new([ PG::ConnectionBad.new("server closed the connection unexpectedly") ]),
      FakeRaw.new([ mirror(900001), mirror(900002) ])
    )
    relay = relay_with(pool)
    pool.on_empty = -> { relay.stop }

    relay.run

    assert_equal 2, pool.connections.size
    assert_equal pool.connections, pool.removed, "both connections are removed from the pool, never checked back in"
    assert pool.connections.all?(&:disconnected?)
    assert_equal [ "LISTEN durable_agent_mirror", "LISTEN durable_agent_reports" ], pool.connections.last.raw_connection.sql
    assert_equal [ 900001, 900002 ], received.map { it.first.id }
    assert_equal [ 1 ], @sleeps
  end

  test "a heartbeat that gets no answer after a quiet wait reconnects" do
    received = capture_mirrors
    pool = FakePool.new(FakeRaw.new([ :timeout, :timeout ], heartbeats: [ true, false ]), FakeRaw.new([ mirror(900001) ]))
    relay = relay_with(pool)
    pool.on_empty = -> { relay.stop }

    relay.run

    assert_equal [ "SELECT 1", "SELECT 1" ], pool.connections.first.raw_connection.queries
    assert_equal 2, pool.connections.size
    assert_equal [ 900001 ], received.map { it.first.id }
  end

  test "failed connects back off from one second doubling to thirty and reset after a successful LISTEN" do
    failure = ActiveRecord::ConnectionNotEstablished.new("connection refused")
    pool = FakePool.new(*[ failure ] * 6, FakeRaw.new([ PG::ConnectionBad.new("gone") ]), failure, FakeRaw.new([]))
    relay = relay_with(pool)
    pool.on_empty = -> { relay.stop }

    relay.run

    assert_equal [ 1, 2, 4, 8, 16, 30, 1, 2 ], @sleeps
  end

  test "after a reconnect on_mirror runs for every conversation updated since the last contact" do
    received = capture_mirrors
    insert_conversation(990101, updated_at: 1.hour.ago)
    insert_conversation(990102, updated_at: 1.second.ago)
    pool = FakePool.new(FakeRaw.new([ PG::ConnectionBad.new("gone") ]), FakeRaw.new([]))
    relay = relay_with(pool, clock: -> { 1.minute.ago })
    pool.on_empty = -> { relay.stop }

    relay.run

    caught_up = received.to_h { |conversation, frame| [ conversation.id, frame ] }
    assert_equal({ entries: [], docs: [], submission: nil }, caught_up[990102])
    assert_not caught_up.key?(990101)
  end

  test "the first connect does not replay anything" do
    received = capture_mirrors
    insert_conversation(990102, updated_at: Time.current)
    pool = FakePool.new(FakeRaw.new([]))
    relay = relay_with(pool)
    pool.on_empty = -> { relay.stop }

    relay.run

    assert_empty received
  end

  private
    def insert_report(conversation_id:)
      DurableAgent::Report.insert({ type: "task_faulted", conversation_id: conversation_id, message: "boom", info: {} }, returning: :id).first["id"]
    end

    def insert_conversation(id, updated_at:)
      DurableAgent::Conversation.insert({ id: id, updated_at: updated_at })
    end

    def capture_mirrors
      [].tap { |received| DurableAgent.config.on_mirror = ->(conversation, **frame) { received << [ conversation, frame ] } }
    end

    def relay_with(pool, clock: -> { 1.hour.from_now })
      @sleeps = []
      DurableAgent::Relay.new(pool: pool, wait: 0.01, sleeper: ->(seconds) { @sleeps << seconds }, clock: clock)
    end

    def mirror(conversation_id)
      [ :notify, "durable_agent_mirror", { conversationId: conversation_id, entries: [], docs: [ "pi.live" ] }.to_json ]
    end

    # Hands out the given raw connections (or raises the given errors) one checkout at a time and calls on_empty
    # once a raw connection has run out of script, so the relay can be stopped.
    class FakePool
      attr_reader :connections, :removed
      attr_accessor :on_empty

      def initialize(*raws)
        @raws, @connections, @removed = raws, [], []
      end

      def checkout
        raw = @raws.shift or raise "the relay connected more often than the test expected"
        raise raw if raw.is_a?(Exception)

        raw.pool = self
        Connection.new(raw).tap { @connections << it }
      end

      def remove(connection) = @removed << connection

      Connection = Struct.new(:raw_connection) do
        def disconnect! = @disconnected = true
        def disconnected? = !!@disconnected
      end
    end

    # Each wait_for_notify takes one step: [:notify, channel, payload] yields it, :timeout returns nil, an
    # exception is raised. Each heartbeat's block takes one of `heartbeats` (true answers, false times out).
    class FakeRaw
      attr_reader :sql, :queries
      attr_writer :pool

      def initialize(script, heartbeats: [])
        @script, @heartbeats, @sql, @queries = script, heartbeats, [], []
      end

      def exec(sql) = @sql << sql

      def wait_for_notify(_timeout)
        case step = @script.shift
        in nil then @pool.on_empty.call
        in :timeout then nil
        in Exception then raise step
        in [ :notify, channel, payload ]
          yield channel, 1, payload
          channel
        end
      end

      def send_query(sql) = @queries << sql
      def block(_timeout) = @heartbeats.shift
      def get_last_result = nil
    end
end

# Runs the relay against the real test database: the NOTIFY comes from another connection, so nothing can be
# inside the test's transaction.
class DurableAgent::RelayListenTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  CONVERSATION_ID = 990201

  setup do
    @callback = DurableAgent.config.instance_variable_get(:@on_mirror)
    DurableAgent::Conversation.insert({ id: CONVERSATION_ID })
  end

  teardown do
    DurableAgent.config.on_mirror = @callback
    DurableAgent::Conversation.where(id: CONVERSATION_ID).delete_all
  end

  test "a NOTIFY from another connection reaches on_mirror" do
    received = Queue.new
    DurableAgent.config.on_mirror = ->(conversation, entries:, **) { received << [ conversation.id, entries ] }
    pool = ActiveRecord::Base.connection_pool
    connection = ActiveRecord::Base.connection
    busy = pool.stat[:busy]

    relay = DurableAgent::Relay.new(wait: 0.1)
    thread = Thread.new { pool.with_connection { ActiveRecord::Base.uncached { relay.run } } }

    payload = { conversationId: CONVERSATION_ID, entries: [], docs: [ "pi.live" ] }.to_json
    # The relay may not be LISTENing yet, and a NOTIFY nobody listens for is gone, so keep sending.
    delivered = 50.times.lazy.filter_map do
      connection.execute("SELECT pg_notify('durable_agent_mirror', #{connection.quote(payload)})")
      received.pop(timeout: 0.2)
    end.first
    assert_equal [ CONVERSATION_ID, [] ], delivered
  ensure
    relay&.stop
    assert thread.join(5), "the relay did not stop" if thread
    assert_equal busy, pool.stat[:busy], "the relay leaked a checked-out connection" if busy
  end
end
