require "test_helper"

class DurableAgent::TaskTest < ActiveSupport::TestCase
  test "kind is stored JSON-encoded and read decoded" do
    run = durable_agent_tasks(:busy_run)

    assert_equal %("pi.run"), run.read_attribute(:kind)
    assert_equal "pi.run", run.kind
    assert_equal 2, DurableAgent::Task.of_kind("pi.run").count
  end

  test "kinds with characters Rails would escape match the sidecar's encoding" do
    DurableAgent::Task.insert({ id: 900690, conversation_id: 900004, kind: %("app.sync<&>"), status: "pending",
      abort_requested: 0, background: 1, record: %({"id":900690}) })

    assert_equal [ 900690 ], DurableAgent::Task.of_kind("app.sync<&>").ids
    assert_equal "app.sync<&>", DurableAgent::Task.find(900690).kind
  end

  test "status and flags" do
    run = durable_agent_tasks(:busy_run)

    assert_equal "running", run.status
    assert_not run.terminal?
    assert_not run.abort_requested?
    assert_not run.background?
    assert_equal({ "status" => "running" }, run.record["state"])
    assert_equal [ run ], DurableAgent::Task.unfinished.to_a
  end
end
