require "test_helper"

class DurableAgent::SidecarTest < ActiveSupport::TestCase
  test "env is derived from the Rails configuration" do
    env = DurableAgent::Sidecar.env

    assert_equal "postgres://localhost/durable_agent_test", env["DATABASE_URL"]
    assert_equal DurableAgent.config.token, env["DURABLE_AGENT_TOKEN"]
    assert_equal "127.0.0.1", env["DURABLE_AGENT_HOST"]
    assert_equal "4010", env["DURABLE_AGENT_PORT"]
    assert_equal "http://127.0.0.1:3000", env["DURABLE_AGENT_RAILS_URL"]
    assert_equal "openai/gpt-6.1-sol", env["DURABLE_AGENT_MODEL"]
    assert_equal Rails.root.join("storage/durable_agent.sqlite").to_s, env["DURABLE_AGENT_STORAGE_PATH"]
    assert_equal Rails.root.join("storage/durable_agent").to_s, env["DURABLE_AGENT_WORKSPACE_ROOT"]
    assert_equal "Dummy", env["DURABLE_AGENT_NAME"]
    assert_equal "all", env["DURABLE_AGENT_MIRROR_DOCS"]
    assert env.values.all?(String)
  end

  test "configured values and provider keys pass through" do
    config = DurableAgent::Configuration.new.tap do |c|
      c.port, c.model, c.mirror_docs, c.token = 4999, "faux/faux-1", %w[ pi.live pi.inbox ], "t"
    end

    with_env("OPENAI_API_KEY" => "sk-test") do
      with_config(config) do
        env = DurableAgent::Sidecar.env
        assert_equal [ "4999", "faux/faux-1", "pi.live,pi.inbox", "t", "sk-test" ],
          env.values_at("DURABLE_AGENT_PORT", "DURABLE_AGENT_MODEL", "DURABLE_AGENT_MIRROR_DOCS", "DURABLE_AGENT_TOKEN", "OPENAI_API_KEY")
        assert_not env.key?("ANTHROPIC_API_KEY")
      end
    end
  end

  test "database url from a hash config" do
    assert_equal "postgres://app:p%40ss@db.internal:5433/app_production",
      database_url(host: "db.internal", port: 5433, username: "app", password: "p@ss", database: "app_production")
    assert_equal "postgres://localhost/app", database_url(database: "app")
    assert_equal "postgres:///app?host=%2Fvar%2Frun%2Fpostgresql", database_url(host: "/var/run/postgresql", database: "app")
  end

  test "database url from a url config" do
    config = ActiveRecord::DatabaseConfigurations::UrlConfig.new("production", "primary", "postgres://u:p@h:1/d", {})
    assert_equal "postgres://u:p@h:1/d", DurableAgent::Sidecar.database_url(config)
  end

  test "command runs the bundle when built, the TypeScript source otherwise" do
    command = DurableAgent::Sidecar.command
    assert_equal "node", command.first
    assert_match %r{sidecar/(dist/sidecar\.js|src/main\.ts)\z}, command.last
    assert command.last.start_with?(DurableAgent::Engine.root.to_s)
  end

  private
    def database_url(**config)
      DurableAgent::Sidecar.database_url(ActiveRecord::DatabaseConfigurations::HashConfig.new("production", "primary", { adapter: "postgresql", **config }))
    end

    def with_config(config)
      previous = DurableAgent.config
      DurableAgent.instance_variable_set(:@config, config)
      yield
    ensure
      DurableAgent.instance_variable_set(:@config, previous)
    end

    def with_env(values)
      previous = values.keys.to_h { [ it, ENV[it] ] }
      values.each { |key, value| ENV[key] = value }
      ENV.delete("ANTHROPIC_API_KEY") if (anthropic = ENV["ANTHROPIC_API_KEY"])
      yield
    ensure
      previous.each { |key, value| ENV[key] = value }
      ENV["ANTHROPIC_API_KEY"] = anthropic if anthropic
    end
end
