require "test_helper"

class DurableAgent::ConversationTest < ActiveSupport::TestCase
  test "harness rows are read-only" do
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_conversations(:idle).update!(owner_task_id: 1) }
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_documents(:idle_live).destroy }
    assert_raises(ActiveRecord::ReadOnlyRecord) { durable_agent_document_revisions(:idle_live_base).destroy }
  end

  test "models read pi-durable's tables under the durable_agent_ prefix" do
    assert_equal %w[ durable_agent_conversations durable_agent_entries durable_agent_tasks durable_agent_submissions
      durable_agent_documents durable_agent_document_revisions durable_agent_reports ],
      [ DurableAgent::Conversation, DurableAgent::Entry, DurableAgent::Task, DurableAgent::Submission, DurableAgent::Document,
        DurableAgent::Document::Revision, DurableAgent::Report ].map(&:table_name)
  end

  test "transcript is the visible entries in order" do
    transcript = durable_agent_conversations(:idle).transcript

    assert_kind_of Array, transcript
    assert_equal %w[ pi.user pi.assistant pi.tool-result pi.assistant ], transcript.map(&:kind)
  end

  test "live state comes from the pi.live document" do
    busy, idle = durable_agent_conversations(:busy), durable_agent_conversations(:idle)

    assert busy.busy?
    assert_not idle.busy?
    assert_equal({}, idle.live)
    assert_equal "Roses are red", DurableAgent::MessageText.text(busy.streaming_message)
    assert_equal [ "lookup_invoice" ], busy.running_tools.map { it["name"] }
    assert_equal [ 900405 ], busy.inbox.map { it["id"] }
    assert_nil idle.streaming_message
  end

  test "documents are the conversation's current ones" do
    idle = durable_agent_conversations(:idle)

    assert_equal [ durable_agent_documents(:idle_live) ], idle.documents.to_a
    assert_equal [], idle.inbox, "the retired pi.inbox incarnation is not read"
    assert_equal({}, idle.document("pi.agent"))
  end

  test "last failure is the newest unanswered input after the last answer" do
    failure = durable_agent_conversations(:failed).last_failure
    assert_equal durable_agent_submissions(:unanswered), failure
    assert_match "provider is not connected", failure.explanation

    assert_nil durable_agent_conversations(:idle).last_failure
  end

  test "last failure with no answer yet is any unanswered input" do
    assert_equal durable_agent_submissions(:owned_unanswered), durable_agent_conversations(:owned).last_failure
  end

  test "parent and parent_at come from the record" do
    forked = durable_agent_conversations(:forked)

    assert_equal durable_agent_conversations(:idle), forked.parent
    assert_equal durable_agent_entries(:answer_with_tool), forked.parent_at
    assert_nil durable_agent_conversations(:idle).parent
    assert_nil durable_agent_conversations(:idle).parent_at
  end

  test "top level excludes conversations a task owns" do
    assert_includes DurableAgent::Conversation.top_level, durable_agent_conversations(:idle)
    assert_not_includes DurableAgent::Conversation.top_level, durable_agent_conversations(:owned)
    assert_equal durable_agent_conversations(:busy), durable_agent_conversations(:owned).owner
  end

  test "associations follow conversation_id" do
    busy = durable_agent_conversations(:busy)

    assert_equal [ durable_agent_tasks(:busy_run) ], busy.tasks.to_a
    assert_equal [ durable_agent_submissions(:placed) ], busy.submissions.to_a
    assert_equal [ durable_agent_reports(:faulted) ], durable_agent_conversations(:failed).reports.to_a
  end

  test "say submits to the sidecar and returns the committed submission" do
    stub_sidecar(submit: { "id" => 900401, "status" => "done" })

    submission = durable_agent_conversations(:idle).say("Hello", request_id: "message-1")

    assert_equal durable_agent_submissions(:answered), submission
    assert_equal [ [ :submit, [ 900001, "Hello" ], { request_id: "message-1", when_busy: nil } ] ], sidecar_calls
  end

  test "say passes when_busy through" do
    stub_sidecar(submit: { "id" => 900404, "status" => "placed" })

    durable_agent_conversations(:busy).say("More", request_id: 7, when_busy: :steer)

    assert_equal :steer, sidecar_calls(:submit).sole.last[:when_busy]
  end

  test "abort goes to the sidecar" do
    stub_sidecar(abort: { "ok" => true })
    durable_agent_conversations(:busy).abort
    assert_equal [ 900002 ], sidecar_calls(:abort).sole.second
  end

  test "start creates on the sidecar and finds the row" do
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
