require "test_helper"

class DurableAgent::ReportTest < ActiveSupport::TestCase
  test "info is JSON text" do
    assert_equal({ "error" => "boom" }, durable_agent_reports(:faulted).info)
  end

  test "type is the report's, not STI" do
    assert_equal "task_faulted", durable_agent_reports(:faulted).type
  end

  test "conversation is optional" do
    assert_equal durable_agent_conversations(:failed), durable_agent_reports(:faulted).conversation
    assert_nil durable_agent_reports(:session).conversation
  end

  test "latest is newest first" do
    assert_equal [ durable_agent_reports(:session), durable_agent_reports(:faulted) ], DurableAgent::Report.latest.to_a
  end
end
