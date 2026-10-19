require "test_helper"
require "net/http"

# Boots the real sidecar on the faux model against the test database, talks to it through the real client, and
# waits for the mirror to deliver the answer. Skipped until the sidecar's dependencies are installed.
class DurableAgent::RoundTripTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  PORT = 4011
  TABLES = %w[ reports submissions documents entries conversations credentials settings ].map { "durable_agent_#{it}" }

  setup do
    skip "sidecar/node_modules missing: run `npm install` in sidecar/ to enable the round-trip test" unless DurableAgent::Sidecar.root.join("node_modules").exist?
    skip "node is not on PATH" unless system("node", "--version", out: File::NULL, err: File::NULL)

    truncate_mirror
    @storage = Rails.root.join("tmp/durable_agent-round-trip.sqlite")
    FileUtils.rm_f(@storage)
    @log = Rails.root.join("log/durable_agent-round-trip.log")

    env = DurableAgent::Sidecar.env.merge(
      "DURABLE_AGENT_PORT" => PORT.to_s, "DURABLE_AGENT_TOKEN" => "round-trip-token", "DURABLE_AGENT_MODEL" => "faux/faux-1",
      "DURABLE_AGENT_STORAGE_PATH" => @storage.to_s, "DURABLE_AGENT_WORKSPACE_ROOT" => Rails.root.join("tmp/durable_agent-workspace").to_s,
      "DURABLE_AGENT_RAILS_URL" => nil # no Rails server in this test: the sidecar runs without tools
    )
    @pid = Process.spawn(env, *DurableAgent::Sidecar.command, out: @log.to_s, err: @log.to_s)

    @client = DurableAgent::Client.new(url: "http://127.0.0.1:#{PORT}", token: "round-trip-token")
    @previous_client = DurableAgent.instance_variable_get(:@client)
    DurableAgent.instance_variable_set(:@client, @client)

    wait_until("sidecar health") { @client.health["ok"] rescue false }
  end

  teardown do
    if @pid
      Process.kill("TERM", @pid)
      Process.wait(@pid)
      DurableAgent.instance_variable_set(:@client, @previous_client)
      truncate_mirror
    end
  end

  test "a conversation round-trips through the sidecar and the mirror" do
    health = @client.health
    assert_equal 1, health["schemaVersion"]
    assert_equal({ "provider" => "faux", "modelId" => "faux-1" }, health["model"])
    assert_includes DurableAgent.auth.keys, "openai"

    conversation = DurableAgent.start(instructions: "Be brief")
    submission = conversation.say("Hello from the test suite", request_id: "round-trip-1")
    assert_equal submission.id, conversation.say("Hello from the test suite", request_id: "round-trip-1").id, "submissions are idempotent on request_id"

    wait_until("answer mirrored") { conversation.submissions.find_by(request_id: "round-trip-1")&.done? }
    ActiveRecord::Base.uncached do
      assert_equal %w[ pi.user pi.assistant ], conversation.transcript.map(&:kind)
      assert conversation.transcript.last.text.present?
      assert_not conversation.reload.busy?
    end

    conversation.say("Second", request_id: "round-trip-2")
    wait_until("second answer") { conversation.entries.visible.of_kind("pi.assistant").count == 2 }

    streams = capture_turbo_stream_broadcasts(conversation) do
      DurableAgent::Relay.new.handle("durable_agent_mirror", { "conversationId" => conversation.id, "entries" => conversation.entries.ids, "docs" => [ "pi.live" ] })
    end
    assert_equal [ "refresh" ], streams.map { it["action"] }

    assert_raises(DurableAgent::UnknownModel) { DurableAgent.start(model: "openai/not-a-model") }
  end

  private
    def wait_until(what, timeout: 20)
      deadline = Time.now + timeout
      # Each test runs inside the executor, which enables the query cache; the mirror is written by another process.
      until ActiveRecord::Base.uncached { yield }
        flunk "timed out waiting for #{what}\n#{@log.read.last(3000)}\n#{mirror_state}" if Time.now > deadline
        sleep 0.2
      end
    end

    def mirror_state
      ActiveRecord::Base.uncached do
        { conversations: DurableAgent::Conversation.ids,
          submissions: DurableAgent::Submission.pluck(:id, :request_id, :status, :reason, :detail),
          entries: DurableAgent::Entry.pluck(:conversation_id, :id, :kind),
          live: DurableAgent::Document.where(kind: "pi.live").pluck(:conversation_id, :body) }.inspect
      end
    end

    def truncate_mirror
      ActiveRecord::Base.connection.execute("TRUNCATE #{TABLES.join(", ")} RESTART IDENTITY CASCADE")
      # The truncate took the fixtures with it; make the next transactional test insert them again.
      ActiveRecord::FixtureSet.reset_cache
    end
end
