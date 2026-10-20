require "test_helper"

class DurableAgent::EntryTest < ActiveSupport::TestCase
  test "harness rows are read-only" do
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_entries(:question).update!(head: 1) }
  end

  test "fields come from the record" do
    answer = durable_agent_entries(:answer_with_tool)

    assert_equal "pi.assistant", answer.kind
    assert_equal 900600, answer.by_task_id
    assert_equal 900100, durable_agent_entries(:system).head
    assert_equal({ "usage" => { "total" => 12 } }, durable_agent_entries(:answer).data)
    assert_nil durable_agent_entries(:question).data
  end

  test "hidden kinds" do
    assert_not durable_agent_entries(:system).visible?
    assert durable_agent_entries(:question).visible?
    assert_equal %w[ pi.system pi.reset ], DurableAgent::Entry::HIDDEN_KINDS
  end

  test "visible and of_kind filter a relation into an array" do
    entries = durable_agent_conversations(:idle).entries.chronologically

    assert_equal [ 900101, 900102, 900103, 900104 ], entries.visible.map(&:id)
    assert_equal [ 900102, 900104 ], entries.of_kind("pi.assistant").map(&:id)
    assert_equal [ 900100, 900101 ], entries.of_kind("pi.system", "pi.user").map(&:id)
  end

  test "text, tool calls, and tool results" do
    assert_equal "What is invoice INV-1?", durable_agent_entries(:question).text
    assert_equal "Let me look.", durable_agent_entries(:answer_with_tool).text
    assert durable_agent_entries(:answer_with_tool).thinking?
    assert_equal [ "lookup_invoice" ], durable_agent_entries(:answer_with_tool).tool_calls.map { it["name"] }
    assert_equal "lookup_invoice", durable_agent_entries(:tool_result).tool_name
    assert_not durable_agent_entries(:tool_result).error?
    assert_includes durable_agent_entries(:tool_result).text, "INV-1"
  end

  test "message metadata: model, stop reason, tokens, cost, timing" do
    answer = durable_agent_entries(:answer)

    assert_equal [ "openai", "gpt-6.1-sol", "openai/gpt-6.1-sol" ], [ answer.provider, answer.model_id, answer.model_ref ]
    assert_equal "stop", answer.stop_reason
    assert_equal 1300, answer.total_tokens
    assert_in_delta 0.01, answer.cost
    assert_equal 2345, answer.duration_ms
    assert_equal Time.zone.at(1792477600), answer.timestamp
    assert answer.answer?
    assert_not answer.failed?

    question = durable_agent_entries(:question)
    assert_nil question.model_ref
    assert_nil question.timestamp
    assert_equal({}, question.usage)
    assert_nil question.total_tokens
  end

  test "a failed assistant entry carries the error and is not an answer" do
    failed = durable_agent_entries(:errored_answer)

    assert failed.failed?
    assert_not failed.answer?
    assert_equal "error", failed.stop_reason
    assert_match "invalid_grant", failed.error_message
    assert_equal "", failed.text
    assert_equal 671, failed.duration_ms
    assert_not durable_agent_entries(:question).failed?, "only assistant entries fail"
  end

  test "kind predicates" do
    assert durable_agent_entries(:question).user?
    assert durable_agent_entries(:answer).assistant?
    assert durable_agent_entries(:tool_result).tool_result?
  end
end
