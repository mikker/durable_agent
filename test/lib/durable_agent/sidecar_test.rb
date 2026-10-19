require "test_helper"

class DurableAgent::SidecarTest < ActiveSupport::TestCase
  test "env is derived from the Rails configuration" do
    env = DurableAgent::Sidecar.env

    assert_equal DurableAgent::Sidecar.database_url, env["DATABASE_URL"]
    assert_equal DurableAgent.config.token, env["DURABLE_AGENT_TOKEN"]
    assert_equal "127.0.0.1", env["DURABLE_AGENT_HOST"]
    assert_equal "4010", env["DURABLE_AGENT_PORT"]
    assert_equal "http://127.0.0.1:3000", env["DURABLE_AGENT_RAILS_URL"]
    assert_equal "openai/gpt-6.1-sol", env["DURABLE_AGENT_MODEL"]
    assert_equal Rails.root.join("storage/durable_agent").to_s, env["DURABLE_AGENT_WORKSPACE_ROOT"]
    assert_equal "Dummy", env["DURABLE_AGENT_NAME"]
    assert_not env.key?("DURABLE_AGENT_STORAGE_PATH")
    assert_not env.key?("DURABLE_AGENT_MIRROR_DOCS")
    assert env.values.all?(String)
  end

  test "the test database's url" do
    case ActiveRecord::Base.connection_db_config.adapter
    when "sqlite3" then assert_equal "sqlite://#{Rails.root.join("storage/test.sqlite3")}", DurableAgent::Sidecar.database_url
    when "postgresql" then assert_equal "postgres://localhost/durable_agent_test", DurableAgent::Sidecar.database_url
    end
  end

  test "configured values and provider keys pass through" do
    config = DurableAgent::Configuration.new.tap do |c|
      c.port, c.model, c.token = 4999, "faux/faux-1", "t"
    end

    with_env("OPENAI_API_KEY" => "sk-test") do
      with_config(config) do
        env = DurableAgent::Sidecar.env
        assert_equal [ "4999", "faux/faux-1", "t", "sk-test" ],
          env.values_at("DURABLE_AGENT_PORT", "DURABLE_AGENT_MODEL", "DURABLE_AGENT_TOKEN", "OPENAI_API_KEY")
        assert_not env.key?("ANTHROPIC_API_KEY")
      end
    end
  end

  test "postgres url from a hash config" do
    assert_equal "postgres://app:p%40ss@db.internal:5433/app_production",
      postgres_url(host: "db.internal", port: 5433, username: "app", password: "p@ss", database: "app_production")
    assert_equal "postgres://localhost/app", postgres_url(database: "app")
    assert_equal "postgres:///app?host=%2Fvar%2Frun%2Fpostgresql", postgres_url(host: "/var/run/postgresql", database: "app")
  end

  test "postgres url carries sslmode" do
    assert_equal "postgres://db.internal/app?sslmode=require", postgres_url(host: "db.internal", database: "app", sslmode: "require")
    assert_equal "postgres:///app?host=%2Ftmp&sslmode=disable", postgres_url(host: "/tmp", database: "app", sslmode: "disable")
  end

  test "sqlite url is the absolute path, relative ones resolved against Rails.root" do
    assert_equal "sqlite://#{Rails.root.join("storage/production.sqlite3")}", sqlite_url(database: "storage/production.sqlite3")
    assert_equal "sqlite:///var/data/app.sqlite3", sqlite_url(database: "/var/data/app.sqlite3")
  end

  test "an explicit url is passed through" do
    config = ActiveRecord::DatabaseConfigurations::UrlConfig.new("production", "primary", "postgres://u:p@h:1/d", {})
    assert_equal "postgres://u:p@h:1/d", DurableAgent::Sidecar.database_url(config)
  end

  test "other adapters are refused" do
    config = ActiveRecord::DatabaseConfigurations::HashConfig.new("production", "primary", { adapter: "mysql2", database: "app" })
    assert_raises(ArgumentError) { DurableAgent::Sidecar.database_url(config) }
  end

  test "command runs the bundle when built, the TypeScript source otherwise" do
    command = DurableAgent::Sidecar.command
    assert_equal "node", command.first
    assert_match %r{sidecar/(dist/sidecar\.js|src/main\.ts)\z}, command.last
    assert command.last.start_with?(DurableAgent::Engine.root.to_s)
  end

  private
    def postgres_url(**config) = database_url(adapter: "postgresql", **config)
    def sqlite_url(**config) = database_url(adapter: "sqlite3", **config)

    def database_url(**config)
      DurableAgent::Sidecar.database_url(ActiveRecord::DatabaseConfigurations::HashConfig.new("production", "primary", config))
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
