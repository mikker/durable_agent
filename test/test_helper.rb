# Configure Rails Environment
ENV["RAILS_ENV"] = "test"

require_relative "../test/dummy/config/environment"
ActiveRecord::Migrator.migrations_paths = [ File.expand_path("../test/dummy/db/migrate", __dir__) ]
require "rails/test_help"
require "turbo/broadcastable/test_helper"
require "durable_agent/test_helper"

Dir[File.expand_path("support/**/*.rb", __dir__)].each { |file| require file }

module ActiveSupport
  class TestCase
    self.fixture_paths = [ File.expand_path("fixtures", __dir__) ]
    self.file_fixture_path = File.expand_path("fixtures/files", __dir__)
    fixtures :all

    include DurableAgent::TestHelper
    include Turbo::Broadcastable::TestHelper
  end
end

ActionDispatch::IntegrationTest.fixture_paths = ActiveSupport::TestCase.fixture_paths
