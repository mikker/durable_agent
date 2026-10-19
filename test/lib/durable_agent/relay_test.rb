require "test_helper"

class DurableAgent::RelayTest < ActiveSupport::TestCase
  setup do
    @relay = DurableAgent::Relay.new
    @callbacks = [ :@on_mirror, :@on_report ].map { DurableAgent.config.instance_variable_get(it) }
  end

  teardown do
    DurableAgent.config.on_mirror, DurableAgent.config.on_report = @callbacks
  end

  test "a mirrored frame refreshes the conversation by default" do
    conversation = durable_agent_conversations(:idle)
    streams = capture_turbo_stream_broadcasts(conversation) do
      @relay.handle("durable_agent_mirror", %({"conversationId": #{conversation.id}, "entries": [900101], "docs": ["pi.live"]}))
    end
    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "on_mirror receives the conversation, its new entries, the doc kinds and the settled submission" do
    received = nil
    DurableAgent.config.on_mirror = ->(conversation, **frame) { received = [ conversation, frame ] }

    @relay.handle("durable_agent_mirror", { "conversationId" => 900001, "entries" => [ 900102, 900101 ], "docs" => [ "pi.live" ] })
    conversation, frame = received
    assert_equal durable_agent_conversations(:idle), conversation
    assert_equal [ durable_agent_entries(:question), durable_agent_entries(:answer_with_tool) ], frame[:entries]
    assert_equal [ "pi.live" ], frame[:docs]
    assert_nil frame[:submission]

    @relay.handle("durable_agent_mirror", { "conversationId" => 900001, "submission" => { "id" => 900401, "status" => "done" } })
    assert_equal [], received.last[:entries]
    assert_equal [], received.last[:docs]
    assert_equal durable_agent_submissions(:answered), received.last[:submission]
  end

  test "a report refreshes its conversation by default" do
    conversation = durable_agent_conversations(:busy)
    report_id = insert_report(conversation_id: conversation.id)

    streams = capture_turbo_stream_broadcasts(conversation) do
      @relay.handle("durable_agent_reports", { "id" => report_id, "type" => "task_faulted", "conversationId" => conversation.id })
    end
    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "a report without a conversation reaches on_report and broadcasts nothing by default" do
    report_id = insert_report(conversation_id: nil)
    assert_nothing_raised { @relay.handle("durable_agent_reports", { "id" => report_id }) }

    received = nil
    DurableAgent.config.on_report = ->(report) { received = report }
    @relay.handle("durable_agent_reports", { "id" => report_id })
    assert_equal "boom", received.message
  end

  test "other channels are ignored" do
    assert_nil @relay.handle("elsewhere", {})
  end

  private
    def insert_report(conversation_id:)
      DurableAgent::Report.insert({ type: "task_faulted", conversation_id: conversation_id, message: "boom", info: {} }, returning: :id).first["id"]
    end
end
