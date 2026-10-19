require "test_helper"
require "generators/durable_agent/install/install_generator"

class DurableAgent::InstallGeneratorTest < Rails::Generators::TestCase
  tests DurableAgent::Generators::InstallGenerator
  destination File.expand_path("../../tmp/generators", __dir__)

  setup do
    prepare_destination
    mkdir_p File.join(destination_root, "config")
    File.write File.join(destination_root, "config/routes.rb"), "Rails.application.routes.draw do\nend\n"
  end

  test "installs the migration, initializer, mount and sidecar process" do
    output = run_generator

    assert_migration "db/migrate/create_durable_agent_tables.rb" do |migration|
      assert_match "ActiveRecord::Migration[#{ActiveRecord::Migration.current_version}]", migration
      %w[ durable_schema durable_metadata record_ids conversations entries tasks submissions documents document_revisions
          reports credentials settings ].each do |table|
        assert_match "create_table :durable_agent_#{table}", migration
      end
      assert_match "t.bigint :id, primary_key: true, default: nil", migration
      assert_no_match "t.jsonb", migration
      assert_no_match "foreign_key", migration
    end
    assert_file "config/initializers/durable_agent.rb" do |initializer|
      assert_match "DurableAgent.configure", initializer
      assert_match "config.on_change", initializer
      assert_match %(config.ssl_options = { redirect: { exclude: ->(request) { request.path.start_with?("/durable_agent") } } }), initializer
      assert_match "config.hosts", initializer
    end
    assert_file "config/routes.rb", %r{mount DurableAgent::Engine => "/durable_agent"}
    assert_file "Procfile.dev" do |procfile|
      assert_equal "web: bin/rails server\nsidecar: bin/rails durable_agent:sidecar\n", procfile
    end
    assert_match "credentials:edit", output
    assert_no_match "relay", output
    assert_no_match "cable", output
  end

  test "appends the sidecar to an existing Procfile.dev once" do
    File.write File.join(destination_root, "Procfile.dev"), "web: bin/rails server -p 3000\ncss: bin/rails tailwindcss:watch\n"

    run_generator
    run_generator [ "--skip" ]

    assert_file "Procfile.dev" do |procfile|
      assert_equal "web: bin/rails server -p 3000\ncss: bin/rails tailwindcss:watch\nsidecar: bin/rails durable_agent:sidecar\n", procfile
    end
  end

  test "the template matches the dummy app's migration" do
    template = File.read(File.expand_path("../../lib/generators/durable_agent/install/templates/create_durable_agent_tables.rb.tt", __dir__))
    dummy = File.read(Dir[File.expand_path("../dummy/db/migrate/*_create_durable_agent_tables.rb", __dir__)].sole)
    assert_equal template.sub("<%= ActiveRecord::Migration.current_version %>", "8.1"), dummy
  end
end
