ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"
require "turbo/broadcastable/test_helper"

Dir[Rails.root.join("test/support/**/*.rb")].each { |file| require file }

module ActiveSupport
  class TestCase
    parallelize(workers: :number_of_processors)

    # Includes the durable_agent_* rows in test/fixtures/durable_agent (ids >= 900000, pi-durable's record shapes).
    fixtures :all

    include SidecarStubs
    include Turbo::Broadcastable::TestHelper

    # What the sidecar does when Rails creates a conversation: commit its row, then answer with the id.
    def sidecar_creates_conversation(id)
      ->(**) do
        DurableAgent::Conversation.insert({ id: id, record: { id: id } })
        { "id" => id }
      end
    end

    # What the sidecar does when Rails submits a message: commit a queued submission, then answer with its id.
    def sidecar_accepts_submission
      next_id = 910000
      ->(conversation_id, content, request_id:, **) do
        id = next_id += 1
        DurableAgent::Submission.insert({ id: id, conversation_id: conversation_id, request_id: request_id.to_json, status: "queued",
          record: { id: id, conversationId: conversation_id, requestId: request_id, type: "input", status: "queued" } })
        { "id" => id, "status" => "queued" }
      end
    end
  end
end
