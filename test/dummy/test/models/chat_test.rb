require "test_helper"

class ChatTest < ActiveSupport::TestCase
  test "start creates the conversation on the sidecar, then the chat" do
    fake_sidecar

    chat = Chat.start

    assert chat.persisted?
    assert_equal "New chat", chat.title
    assert_equal 1, sidecar_calls(:create_conversation).size
    assert chat.conversation.persisted?
  end

  test "start leaves no chat behind when the sidecar is down" do
    stub_sidecar(create_conversation: DurableAgent::Unavailable)

    assert_no_difference -> { Chat.count } do
      assert_raises(DurableAgent::Unavailable) { Chat.start }
    end
  end

  test "say submits with a fresh request id and names a new chat after its first message" do
    fake_sidecar
    chat = Chat.start

    chat.say("Tell me a long story about a lighthouse keeper who finds a message in a bottle")
    chat.say("Shorter, please")

    assert_equal "Tell me a long story about a lighthouse keeper who finds ...", chat.reload.title
    calls = sidecar_calls(:submit)
    assert_equal [ chat.durable_agent_conversation_id, "Shorter, please" ], calls.last[1]
    assert_equal 2, chat.conversation.submissions.count
    assert_equal 2, calls.map { |call| call[2][:request_id] }.uniq.size
    assert calls.all? { |call| call[2][:request_id].match?(/\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/) }
  end

  test "status and the conversation's metadata" do
    assert_equal :idle, chats(:invoice).status
    assert_equal :busy, chats(:poem).status
    assert_equal :failed, chats(:failed).status
    assert_equal :failed, chats(:errored).status
    assert_equal "openai/gpt-6.1-sol", chats(:invoice).model
    assert_nil chats(:poem).model
    assert_equal 3100, chats(:invoice).total_tokens
    assert_in_delta 0.02, chats(:invoice).total_cost
  end

  test "say on a named chat keeps its title" do
    fake_sidecar
    chat = chats(:failed)

    chat.say("Hello?")
    assert_equal "Are you there?", chat.reload.title
  end

  test "stop aborts the run" do
    fake_sidecar
    chats(:poem).stop
    assert_equal [ [ :abort, [ 900002 ], {} ] ], sidecar_calls
  end

  test "reads the transcript and live state from the conversation" do
    assert_equal %w[ pi.user pi.assistant pi.tool-result pi.assistant ], chats(:invoice).transcript.map(&:kind)
    assert chats(:poem).busy?
    assert_equal "Roses are red", DurableAgent::MessageText.text(chats(:poem).streaming_message)
    assert_equal "no_model", chats(:failed).last_failure.reason
  end

  test "last activity is the conversation's newest entry, else its creation" do
    assert_equal durable_agent_entries(:answer).created_at, chats(:invoice).last_activity_at

    fake_sidecar
    chat = Chat.start
    assert_equal chat.conversation.created_at, chat.last_activity_at
    assert_not_nil chat.last_activity_at
  end

  test "by_last_activity orders by the conversations' newest entries" do
    assert_equal chats(:invoice, :poem, :failed, :errored), Chat.by_last_activity.to_a
  end
end
