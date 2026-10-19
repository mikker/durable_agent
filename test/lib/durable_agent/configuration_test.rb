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

  test "tools resolve class names lazily" do
    @config.tools = [ "DurableAgent::Tool" ]
    assert_equal [ DurableAgent::Tool ], @config.tools
    assert_equal DurableAgent::Tool, @config.tool("tool")
    assert_nil @config.tool("missing")
  end
end
