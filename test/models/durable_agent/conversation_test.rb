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

  test "model is pinned in the pi.agent document" do
    assert_equal "faux/faux-1", durable_agent_conversations(:failed).model
    assert_equal({ "model" => { "provider" => "faux", "modelId" => "faux-1" } }, durable_agent_conversations(:failed).agent)
    assert_nil durable_agent_conversations(:idle).model, "no pi.agent document yet"
  end

  test "provider and account come from the pinned model" do
    on_account = durable_agent_conversations(:on_account)
    assert_equal "openai@u42/gpt-6.1-sol", on_account.model
    assert_equal "openai", on_account.provider
    assert_equal "u42", on_account.account

    errored = durable_agent_conversations(:errored)
    assert_equal "openai", errored.provider
    assert_nil errored.account

    assert_nil durable_agent_conversations(:idle).provider
    assert_nil durable_agent_conversations(:idle).account
  end

  test "documents are the conversation's current ones" do
    idle = durable_agent_conversations(:idle)

    assert_equal [ durable_agent_documents(:idle_live), durable_agent_documents(:idle_usage) ], idle.documents.order(:id).to_a
    assert_equal [], idle.inbox, "the retired pi.inbox incarnation is not read"
    assert_equal({}, idle.document("pi.agent"))
  end

  test "last failure is the newest unanswered input after the last answer" do
    failure = durable_agent_conversations(:failed).last_failure
    assert_equal durable_agent_submissions(:unanswered), failure
    assert_match "Model faux/faux-1 is not available", failure.explanation

    assert_nil durable_agent_conversations(:idle).last_failure
  end

  test "last failure looks past an assistant entry that ended in an error" do
    errored = durable_agent_conversations(:errored)

    assert_equal durable_agent_submissions(:model_error), errored.last_failure
    assert_equal "The model returned an error. OAuth refresh failed for openai: OpenAI OAuth token request failed (400): {\n  \"error\": \"invalid_grant\"\n}",
      errored.last_failure.explanation
    assert_equal "openai/gpt-6.1-sol", errored.model
  end

  test "usage totals come from the pi.usage document" do
    idle = durable_agent_conversations(:idle)

    assert_equal %w[ openai/gpt-6.1-sol openai/gpt-6-sol ], idle.usage_by_model.keys
    assert_equal 3100, idle.total_tokens
    assert_in_delta 0.02, idle.total_cost
    assert_equal({ "lookup_invoice" => { "calls" => 1 } }, idle.usage["tools"])

    assert_equal({}, durable_agent_conversations(:busy).usage)
    assert_equal 0, durable_agent_conversations(:busy).total_tokens
    assert_equal 0, durable_agent_conversations(:busy).total_cost
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

  test "top level excludes conversations a task owns and the root" do
    assert_includes DurableAgent::Conversation.top_level, durable_agent_conversations(:idle)
    assert_not_includes DurableAgent::Conversation.top_level, durable_agent_conversations(:owned)
    assert_not_includes DurableAgent::Conversation.top_level, durable_agent_conversations(:root)
    assert_equal durable_agent_conversations(:busy), durable_agent_conversations(:owned).owner
  end

  test "root is the conversation the sidecar creates at boot" do
    assert_equal durable_agent_conversations(:root), DurableAgent::Conversation.root
    assert DurableAgent::Conversation.root.root?
    assert_not durable_agent_conversations(:idle).root?
  end

  test "created_at, and last activity from the newest entry" do
    idle, forked = durable_agent_conversations(:idle), durable_agent_conversations(:forked)

    assert_in_delta 2.days.ago, idle.created_at, 5.seconds
    assert_in_delta 1.hour.ago, idle.last_activity_at, 5.seconds
    assert_equal forked.created_at, forked.last_activity_at, "no entries of its own"
    assert_kind_of Time, durable_agent_entries(:answer).created_at
    assert_kind_of Time, durable_agent_submissions(:answered).created_at
  end

  test "created_at comes from the column default when the sidecar inserts a row" do
    DurableAgent::Conversation.connection.execute(%(INSERT INTO durable_agent_conversations (id, record) VALUES (900099, '{"id":900099}')))
    DurableAgent::Entry.connection.execute(%(INSERT INTO durable_agent_entries (id, conversation_id, commit_seq, record) VALUES (900199, 900099, 1, '{}')))
    DurableAgent::Submission.connection.execute(%(INSERT INTO durable_agent_submissions (id, conversation_id, status, record) VALUES (900499, 900099, 'queued', '{}')))

    conversation = DurableAgent.conversation(900099)
    assert_in_delta Time.current, conversation.created_at, 5.seconds
    assert_in_delta Time.current, conversation.entries.sole.created_at, 5.seconds
    assert_in_delta Time.current, conversation.submissions.sole.created_at, 5.seconds
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

  test "start runs on an account, normalized" do
    stub_sidecar(create_conversation: { "id" => 900007 })

    assert_equal durable_agent_conversations(:on_account), DurableAgent.start(account: 42)
    assert_equal({ model: nil, instructions: nil, account: "42" }, sidecar_calls(:create_conversation).sole.last)

    assert_raises(ArgumentError) { DurableAgent.start(account: "u@42") }
    assert_equal 1, sidecar_calls(:create_conversation).size
  end

  test "conversation finds by id" do
    assert_equal durable_agent_conversations(:busy), DurableAgent.conversation(900002)
    assert_raises(ActiveRecord::RecordNotFound) { DurableAgent.conversation(2) }
  end
end
