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

  test "kind predicates" do
    assert durable_agent_entries(:question).user?
    assert durable_agent_entries(:answer).assistant?
    assert durable_agent_entries(:tool_result).tool_result?
  end
end
