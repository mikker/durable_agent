require "test_helper"

# Boots the real sidecar on the faux model against the test database, talks to it through the real client, and
# reads the answer from pi-durable's own tables. Skipped until the sidecar's dependencies are installed.
class DurableAgent::RoundTripTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  PORT = 4011
  TABLES = %w[ durable_schema durable_metadata record_ids conversations entries tasks submissions documents document_revisions
    reports credentials settings ].map { "durable_agent_#{it}" }

  setup do
    skip "sidecar/node_modules missing: run `npm install` in sidecar/ to enable the round-trip test" unless DurableAgent::Sidecar.root.join("node_modules").exist?
    skip "node is not on PATH" unless system("node", "--version", out: File::NULL, err: File::NULL)

    clear_tables
    @log = Rails.root.join("log/durable_agent-round-trip.log")

    env = DurableAgent::Sidecar.env.merge(
      "DURABLE_AGENT_PORT" => PORT.to_s, "DURABLE_AGENT_TOKEN" => "round-trip-token", "DURABLE_AGENT_MODEL" => "faux/faux-1",
      "DURABLE_AGENT_WORKSPACE_ROOT" => Rails.root.join("tmp/durable_agent-workspace").to_s,
      "DURABLE_AGENT_RAILS_URL" => nil # no Rails server in this test: the sidecar runs without tools or events
    )
    @pid = Process.spawn(env, *DurableAgent::Sidecar.command, out: @log.to_s, err: @log.to_s)

    @client = DurableAgent::Client.new(url: "http://127.0.0.1:#{PORT}", token: "round-trip-token")
    @previous_client = DurableAgent.instance_variable_get(:@client)
    DurableAgent.instance_variable_set(:@client, @client)

    # Commands answer 503 "starting" until the harness has resumed, which it does after tools load.
    wait_until("sidecar resumed") { @client.health["resumed"] rescue false }
  end

  teardown do
    if @pid
      Process.kill("TERM", @pid)
      Process.wait(@pid)
      DurableAgent.instance_variable_set(:@client, @previous_client)
      clear_tables
    end
  end

  test "a conversation round-trips through the sidecar and the shared database" do
    health = @client.health
    assert_equal 2, health["schemaVersion"]
    assert_equal 1, health["harnessSchemaVersion"]
    assert_equal ActiveRecord::Base.connection_db_config.adapter == "sqlite3" ? "sqlite" : "postgres", health["database"]
    assert_equal({ "provider" => "faux", "modelId" => "faux-1" }, health["model"])
    assert_includes DurableAgent.auth.keys, "openai"

    conversation = DurableAgent.start(instructions: "Be brief")
    submission = conversation.say("Hello from the test suite", request_id: "round-trip-1")
    assert submission.persisted?, "the sidecar commits the submission before it answers"
    assert_equal "round-trip-1", submission.request_id
    assert_equal submission, conversation.say("Hello from the test suite", request_id: "round-trip-1"), "submissions are idempotent on request_id"

    wait_until("answer") { conversation.submissions.for_request("round-trip-1").first&.done? }
    ActiveRecord::Base.uncached do
      assert_equal %w[ pi.user pi.assistant ], conversation.transcript.map(&:kind)
      assert conversation.transcript.last.text.present?

      live = conversation.documents.of_kind("pi.live").sole
      assert_equal [ "base" ], live.revisions.map(&:kind), "the sidecar stores pi.live as one base revision"
      assert_equal live.value, conversation.live
      assert_not conversation.busy?
    end

    second = conversation.say("Second", request_id: "round-trip-2")
    assert second.persisted?
    wait_until("second answer") { conversation.entries.of_kind("pi.assistant").size == 2 }

    assert_raises(DurableAgent::UnknownModel) { DurableAgent.start(model: "openai/not-a-model") }
  end

  private
    def wait_until(what, timeout: 20)
      deadline = Time.now + timeout
      # Each test runs inside the executor, which enables the query cache; the sidecar writes from another process.
      until ActiveRecord::Base.uncached { yield }
        flunk "timed out waiting for #{what}\n#{@log.read.last(3000)}\n#{database_state}" if Time.now > deadline
        sleep 0.2
      end
    end

    def database_state
      ActiveRecord::Base.uncached do
        { conversations: DurableAgent::Conversation.ids,
          submissions: DurableAgent::Submission.pluck(:id, :request_id, :status, :record),
          entries: DurableAgent::Entry.pluck(:conversation_id, :id, :record).map { [ it[0], it[1], JSON.parse(it[2])["kind"] ] },
          documents: DurableAgent::Document.pluck(:id, :kind, :owner_id, :retired_at) }.inspect
      end
    end

    # Plain deletes, so the same code runs on SQLite and Postgres. The harness ids come from
    # durable_agent_durable_metadata, which the sidecar seeds again at boot.
    def clear_tables
      TABLES.each { |table| ActiveRecord::Base.connection.delete("DELETE FROM #{table}") }
      # The deletes took the fixtures with them; make the next transactional test insert them again.
      ActiveRecord::FixtureSet.reset_cache
    end
end
