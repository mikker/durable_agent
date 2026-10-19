ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"
require "turbo/broadcastable/test_helper"
require "durable_agent/test_helper"

module ActiveSupport
  class TestCase
    parallelize(workers: :number_of_processors)

    # Includes the durable_agent_* rows in test/fixtures/durable_agent (ids from 900000, pi-durable's record shapes).
    fixtures :all

    # stub_sidecar, sidecar_calls, and fake_sidecar, which commits rows the way the sidecar does (ids from 950001).
    include DurableAgent::TestHelper
    include Turbo::Broadcastable::TestHelper
  end
end
