require "test_helper"

class DurableAgent::ConfigurationTest < ActiveSupport::TestCase
  setup { @config = DurableAgent::Configuration.new }

  test "defaults" do
    assert_equal "openai/gpt-6.1-sol", @config.model
    assert_equal "http://127.0.0.1:4010", @config.url
    assert_equal "http://127.0.0.1:3000", @config.rails_url
    assert_equal [], @config.tools

    @config.port = 4020
    assert_equal "http://127.0.0.1:4020", @config.url
  end

  test "model, host, port and rails_url default to the DURABLE_AGENT_* variables the sidecar reads" do
    env = { "DURABLE_AGENT_MODEL" => "faux/faux-1", "DURABLE_AGENT_HOST" => "0.0.0.0", "DURABLE_AGENT_PORT" => "4077",
            "DURABLE_AGENT_RAILS_URL" => "http://127.0.0.1:3077" }
    previous = ENV.slice(*env.keys)
    ENV.update(env)

    config = DurableAgent::Configuration.new
    assert_equal "faux/faux-1", config.model
    assert_equal "http://0.0.0.0:4077", config.url
    assert_equal 4077, config.port
    assert_equal "http://127.0.0.1:3077", config.rails_url
    assert_equal env.merge("DURABLE_AGENT_PORT" => "4077"), DurableAgent::Sidecar.env.slice(*env.keys)
  ensure
    env.each_key { |key| previous.key?(key) ? ENV[key] = previous[key] : ENV.delete(key) }
  end

  test "token falls back to the environment, then to one derived from secret_key_base in test" do
    derived = @config.token
    assert_equal 64, derived.size
    assert_equal derived, DurableAgent::Configuration.new.token, "both halves must derive the same token"

    ENV["DURABLE_AGENT_TOKEN"] = "from-env"
    assert_equal "from-env", DurableAgent::Configuration.new.token
  ensure
    ENV.delete("DURABLE_AGENT_TOKEN")
  end

  test "production without a token raises" do
    Rails.env = "production"
    assert_raises(DurableAgent::Configuration::MissingToken) { @config.token }
  ensure
    Rails.env = "test"
  end

  test "an assigned token wins" do
    @config.token = "set"
    assert_equal "set", @config.token
  end

  test "a blank token is refused, never compared" do
    @config.token = ""
    assert_raises(DurableAgent::Configuration::MissingToken) { @config.token }

    @config.token = "  "
    assert_raises(DurableAgent::Configuration::MissingToken) { @config.token }
  end

  test "on_change broadcasts a refresh to the conversation by default" do
    conversation = durable_agent_conversations(:idle)
    streams = capture_turbo_stream_broadcasts(conversation) { @config.on_change.call(conversation) }
    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "on_report broadcasts to the report's conversation, when it has one" do
    report = durable_agent_reports(:faulted)
    streams = capture_turbo_stream_broadcasts(report.conversation) { @config.on_report.call(report) }
    assert_equal [ "refresh" ], streams.map { it["action"] }

    assert_nothing_raised { @config.on_report.call(durable_agent_reports(:session)) }
  end

  test "callbacks can be replaced" do
    @config.on_change = ->(conversation) { conversation.id }
    assert_equal 900001, @config.on_change.call(durable_agent_conversations(:idle))
  end

  test "tools resolve class names lazily" do
    @config.tools = [ "DurableAgent::Tool" ]
    assert_equal [ DurableAgent::Tool ], @config.tools
    assert_equal DurableAgent::Tool, @config.tool("tool")
    assert_nil @config.tool("missing")
  end
end
