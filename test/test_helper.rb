# Configure Rails Environment
ENV["RAILS_ENV"] = "test"

require_relative "../test/dummy/config/environment"
ActiveRecord::Migrator.migrations_paths = [ File.expand_path("../test/dummy/db/migrate", __dir__) ]
require "rails/test_help"
require "turbo/broadcastable/test_helper"
require "durable_agent/test_helper"

Dir[File.expand_path("support/**/*.rb", __dir__)].each { |file| require file }

# In fixtures: a value as the JSON text the sidecar stores, and a string as pi-durable indexes it, each quoted for YAML.
module DurableAgent::FixtureHelpers
  def json_text(value) = value.to_json.to_json
  def indexed(value) = DurableAgent::IndexedString.encode(value).to_json
end
ActiveRecord::FixtureSet.context_class.include DurableAgent::FixtureHelpers

module ActiveSupport
  class TestCase
    self.fixture_paths = [ File.expand_path("fixtures", __dir__) ]
    self.file_fixture_path = File.expand_path("fixtures/files", __dir__)
    fixtures :all

    include DurableAgent::TestHelper
    include Turbo::Broadcastable::TestHelper

    private
      # Runs the block with `config` as DurableAgent.config.
      def with_config(config)
        previous = DurableAgent.config
        DurableAgent.instance_variable_set(:@config, config)
        yield
      ensure
        DurableAgent.instance_variable_set(:@config, previous)
      end
  end
end

ActionDispatch::IntegrationTest.fixture_paths = ActiveSupport::TestCase.fixture_paths
