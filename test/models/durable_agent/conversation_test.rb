require "test_helper"

class DurableAgent::ConversationTest < ActiveSupport::TestCase
  test "mirror rows are read-only" do
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_conversations(:idle).update!(owner_task_id: 1) }
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_documents(:idle_live).destroy }
  end

  test "mirror tables carry the durable_agent_ prefix" do
    assert_equal %w[ durable_agent_conversations durable_agent_entries durable_agent_documents durable_agent_submissions durable_agent_reports ],
      [ DurableAgent::Conversation, DurableAgent::Entry, DurableAgent::Document, DurableAgent::Submission, DurableAgent::Report ].map(&:table_name)
  end

  test "transcript is the visible entries in order" do
    assert_equal %w[ pi.user pi.assistant pi.tool-result pi.assistant ], durable_agent_conversations(:idle).transcript.map(&:kind)
  end

  test "live state" do
    busy, idle = durable_agent_conversations(:busy), durable_agent_conversations(:idle)

    assert busy.busy?
    assert_not idle.busy?
    assert_equal "Roses are red", DurableAgent::MessageText.text(busy.streaming_message)
    assert_equal [ "lookup_invoice" ], busy.running_tools.map { it["name"] }
    assert_equal 1, busy.inbox.size
    assert_equal({}, idle.document("pi.agent"))
    assert_nil idle.streaming_message
  end

  test "last failure is the newest unanswered input after the last answer" do
    failure = durable_agent_conversations(:failed).last_failure
    assert_equal durable_agent_submissions(:unanswered), failure
    assert_match "provider is not connected", failure.explanation

    assert_nil durable_agent_conversations(:idle).last_failure
  end

  test "say submits to the sidecar and returns the mirrored submission" do
    stub_sidecar(submit: { "id" => 900401, "status" => "done" })

    submission = durable_agent_conversations(:idle).say("Hello", request_id: "message-1")

    assert_equal durable_agent_submissions(:answered), submission
    assert_equal [ [ :submit, [ 900001, "Hello" ], { request_id: "message-1", when_busy: nil } ] ], sidecar_calls
  end

  test "say returns an unsaved stand-in when the mirror has not caught up" do
    stub_sidecar(submit: { "id" => 12, "status" => "queued" })

    submission = durable_agent_conversations(:idle).say("Hello", request_id: 7, when_busy: :steer)

    assert submission.new_record?
    assert_equal [ 12, "queued", "7", 900001 ], [ submission.id, submission.status, submission.request_id, submission.conversation_id ]
    assert submission.pending?
    assert_equal :steer, sidecar_calls(:submit).sole.last[:when_busy]
  end

  test "abort goes to the sidecar" do
    stub_sidecar(abort: { "ok" => true })
    durable_agent_conversations(:busy).abort
    assert_equal [ 900002 ], sidecar_calls(:abort).sole.second
  end

  test "start creates on the sidecar and finds the mirror row" do
    stub_sidecar(create_conversation: { "id" => 900001 })

    assert_equal durable_agent_conversations(:idle), DurableAgent.start(model: "faux/faux-1", instructions: "Be brief")
    assert_equal({ model: "faux/faux-1", instructions: "Be brief" }, sidecar_calls(:create_conversation).sole.last)
  end

  test "start leaves the model to the sidecar's default" do
    stub_sidecar(create_conversation: { "id" => 900002 })
    DurableAgent.start
    assert_equal({ model: nil, instructions: nil }, sidecar_calls(:create_conversation).sole.last)
  end

  test "conversation finds by id" do
    assert_equal durable_agent_conversations(:busy), DurableAgent.conversation(900002)
    assert_raises(ActiveRecord::RecordNotFound) { DurableAgent.conversation(1) }
  end
end
