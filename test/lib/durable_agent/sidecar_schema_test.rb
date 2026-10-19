require "test_helper"

# The sidecar's test suite creates its schema from SQL renderings of the install migration. Keep the tables and
# columns of both in step with what the migration actually produces on this database.
class DurableAgent::SidecarSchemaTest < ActiveSupport::TestCase
  %w[ schema.sqlite.sql schema.postgres.sql ].each do |file|
    test "sidecar/sql/#{file} has the migration's tables and columns" do
      path = DurableAgent::Sidecar.root.join("sql", file)
      skip "#{path} does not exist yet" unless path.exist?

      assert_equal migrated_tables, tables_in(path.read)
    end
  end

  private
    def migrated_tables
      connection = ActiveRecord::Base.connection
      connection.tables.grep(/\Adurable_agent_/).sort.to_h { |table| [ table, connection.columns(table).map(&:name).sort ] }
    end

    CONSTRAINTS = %w[ primary constraint check unique foreign ].freeze

    def tables_in(sql)
      sql.gsub(/--[^\n]*/, "").scan(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?\s*\((.*?)\)\s*(?:strict\s*)?;/im).to_h do |table, body|
        columns = split_columns(body).filter_map do |definition|
          name = definition.strip[/\A"?(\w+)"?/, 1]
          name unless name.nil? || name.downcase.in?(CONSTRAINTS)
        end
        [ table, columns.sort ]
      end.sort.to_h
    end

    # Commas inside parentheses (CHECK (x IN (0, 1)), PRIMARY KEY (a, b)) do not separate columns.
    def split_columns(body)
      depth, current, parts = 0, +"", []
      body.each_char do |char|
        depth += 1 if char == "("
        depth -= 1 if char == ")"
        if char == "," && depth.zero?
          parts << current
          current = +""
        else
          current << char
        end
      end
      parts << current
    end
end
