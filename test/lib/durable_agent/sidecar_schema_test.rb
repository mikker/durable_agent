require "test_helper"

# The sidecar's test suite creates its schema from SQL renderings of the install migration. Each test runs the
# migration and the SQL file against two fresh databases of one adapter and compares what the adapter reports:
# tables, primary keys, columns (type, nullability, default, autoincrement) and indexes (name, columns, order,
# where, uniqueness). Both run on every suite; the Postgres one needs the durable_agent_test database.
class DurableAgent::SidecarSchemaTest < ActiveSupport::TestCase
  MIGRATION = Dir[File.expand_path("../../dummy/db/migrate/*_create_durable_agent_tables.rb", __dir__)].sole

  test "sidecar/sql/schema.sqlite.sql matches the migration on SQLite" do
    migrated = on_sqlite { |connection| migrate(connection) }
    rendered = on_sqlite { |connection| connection.raw_connection.execute_batch(sql("schema.sqlite.sql")) }

    assert_schema_equal migrated, rendered
  end

  test "sidecar/sql/schema.postgres.sql matches the migration on Postgres" do
    migrated = on_postgres { |connection| migrate(connection) }
    rendered = on_postgres { |connection| connection.execute(sql("schema.postgres.sql")) }

    assert_schema_equal migrated, rendered
  end

  test "the harness tables use a rowid alias on SQLite, as pi-durable's own DDL does" do
    schema = on_sqlite { |connection| migrate(connection) }

    %w[ durable_schema durable_metadata record_ids conversations entries tasks submissions documents ].each do |table|
      key = schema.fetch("durable_agent_#{table}")[:columns].first
      assert_equal "integer", key.second.downcase, "durable_agent_#{table}.#{key.first} must be INTEGER PRIMARY KEY"
    end
  end

  test "the test database, loaded from schema.rb, is what the migration makes on this adapter" do
    connection = ActiveRecord::Base.connection
    migrated = connection.adapter_name == "SQLite" ? on_sqlite { |sqlite| migrate(sqlite) } : on_postgres { |postgres| migrate(postgres) }

    assert_schema_equal migrated, schema_of(connection)
  end

  private
    def assert_schema_equal(migrated, rendered)
      assert_equal migrated.keys, rendered.keys, "tables"
      migrated.each { |table, schema| assert_equal schema, rendered[table], table }
    end

    def migrate(connection)
      require MIGRATION
      ActiveRecord::Migration.suppress_messages { CreateDurableAgentTables.new.exec_migration(connection, :up) }
    end

    def sql(file) = DurableAgent::Sidecar.root.join("sql", file).read

    def on_sqlite
      require "active_record/connection_adapters/sqlite3_adapter"
      connection = ActiveRecord::ConnectionAdapters::SQLite3Adapter.new(adapter: "sqlite3", database: ":memory:")
      yield connection
      schema_of(connection)
    ensure
      connection&.disconnect!
    end

    # Each side gets a schema of its own inside a transaction that is rolled back, so nothing is left behind.
    def on_postgres
      require "active_record/connection_adapters/postgresql_adapter"
      connection = ActiveRecord::ConnectionAdapters::PostgreSQLAdapter.new(postgres_config)
      begin
        connection.execute("SELECT 1")
      rescue ActiveRecord::ActiveRecordError => error
        skip "Postgres is not reachable (#{error.class}): run DURABLE_AGENT_DB=postgres bin/rails db:create"
      end

      name, schema = "durable_agent_schema_test_#{SecureRandom.hex(4)}", nil
      connection.transaction do
        connection.execute("CREATE SCHEMA #{name}")
        connection.execute("SET LOCAL search_path TO #{name}")
        yield connection
        schema = schema_of(connection)
        raise ActiveRecord::Rollback
      end
      schema
    ensure
      connection&.disconnect!
    end

    def postgres_config
      if ActiveRecord::Base.connection_db_config.adapter == "postgresql"
        ActiveRecord::Base.connection_db_config.configuration_hash
      else
        { adapter: "postgresql", database: "durable_agent_test" }
      end
    end

    def schema_of(connection)
      connection.tables.grep(/\Adurable_agent_/).sort.to_h do |table|
        [ table, {
          primary_key: connection.primary_keys(table),
          columns: connection.columns(table).map { |column|
            [ column.name, column.sql_type, column.null, column.default, column.default_function, column.auto_incremented_by_db? ]
          },
          indexes: connection.indexes(table).sort_by(&:name).map { |index|
            [ index.name, index.columns, orders(connection, index), unparenthesized(index.where), index.unique ]
          }
        } ]
      end
    end

    # Postgres reports a partial index's predicate in parentheses; schema.rb then carries them to SQLite.
    def unparenthesized(where)
      where&.match(/\A\((.*)\)\z/) ? $1 : where
    end

    # Rails reads SQLite's index orders from the CREATE INDEX text and only sees quoted column names; ask SQLite.
    def orders(connection, index)
      if connection.adapter_name == "SQLite"
        connection.select_rows("SELECT name, desc FROM pragma_index_xinfo(#{connection.quote(index.name)}) WHERE key = 1")
          .filter_map { |column, desc| [ column, :desc ] if desc == 1 }.to_h
      else
        index.orders
      end
    end
end
