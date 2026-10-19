require "test_helper"

class DurableAgent::EntryTest < ActiveSupport::TestCase
  test "mirror rows are read-only" do
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_entries(:question).update!(kind: "x") }
  end

  test "hidden kinds" do
    assert_not durable_agent_entries(:system).visible?
    assert durable_agent_entries(:question).visible?
    assert_equal %w[ pi.system pi.reset ], DurableAgent::Entry::HIDDEN_KINDS
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
