require "test_helper"

class DurableAgent::SubmissionTest < ActiveSupport::TestCase
  test "request_id is stored JSON-encoded and read decoded" do
    answered = durable_agent_submissions(:answered)

    assert_equal %("message-1"), answered.read_attribute(:request_id)
    assert_equal "message-1", answered.request_id
    assert_nil durable_agent_submissions(:owned_unanswered).request_id
  end

  test "for_request encodes the id" do
    assert_equal [ durable_agent_submissions(:answered) ], DurableAgent::Submission.for_request("message-1").to_a
    assert_equal [ durable_agent_submissions(:answered) ], durable_agent_conversations(:idle).submissions.for_request("message-1").to_a
    assert_empty durable_agent_conversations(:busy).submissions.for_request("message-1")
  end

  test "integer request ids match their string form, as the client sends them" do
    assert_equal %("42"), DurableAgent::Submission.for_request(42).where_values_hash["request_id"]
  end

  test "for_request finds ids with characters Rails would escape, stored as the sidecar writes them" do
    # The column text JSON.stringify produces for this id, written by hand.
    DurableAgent::Submission.insert({ id: 900490, conversation_id: 900004, request_id: %("a&b <x> \\"q\\" é😀 "), status: "queued",
      record: %({"id":900490,"conversationId":900004,"type":"input","status":"queued"}) })

    submission = DurableAgent::Submission.for_request(%(a&b <x> "q" é😀 )).sole
    assert_equal 900490, submission.id
    assert_equal %(a&b <x> "q" é😀 ), submission.request_id
  end

  test "fields come from the record" do
    answered, failed = durable_agent_submissions(:answered), durable_agent_submissions(:unanswered_before_answer)

    assert_equal [ "input", 900101, 900104 ], [ answered.type, answered.entry_id, answered.answer_entry_id ]
    assert_equal durable_agent_entries(:question), answered.entry
    assert_equal durable_agent_entries(:answer), answered.answer
    assert_equal [ "run_failed", { "message" => "429" } ], [ failed.reason, failed.detail ]
    assert_equal "The model request failed.", failed.explanation
    assert_nil durable_agent_submissions(:placed).answer
  end

  test "status scopes and predicates" do
    assert_equal [ durable_agent_submissions(:placed) ], DurableAgent::Submission.pending.to_a
    assert_equal 4, DurableAgent::Submission.settled.count
    assert durable_agent_submissions(:placed).pending?
    assert durable_agent_submissions(:answered).done?
    assert durable_agent_submissions(:unanswered).unanswered?
  end

  test "unknown reasons are explained generically" do
    submission = DurableAgent::Submission.new(record: { "reason" => "withdrawn" })
    assert_equal "The agent did not answer (withdrawn).", submission.explanation
  end
end
