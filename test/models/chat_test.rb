require "test_helper"

class ChatTest < ActiveSupport::TestCase
  test "start creates the conversation on the sidecar, then the chat" do
    stub_sidecar(create_conversation: sidecar_creates_conversation(900009))

    chat = Chat.start

    assert chat.persisted?
    assert_equal "New chat", chat.title
    assert_equal DurableAgent::Conversation.find(900009), chat.conversation
    assert_equal 1, sidecar_calls(:create_conversation).size
  end

  test "start leaves no chat behind when the sidecar is down" do
    stub_sidecar(create_conversation: DurableAgent::Unavailable)

    assert_no_difference -> { Chat.count } do
      assert_raises(DurableAgent::Unavailable) { Chat.start }
    end
  end

  test "say submits with a fresh request id and names a new chat after its first message" do
    stub_sidecar(create_conversation: sidecar_creates_conversation(900009), submit: sidecar_accepts_submission)
    chat = Chat.start

    chat.say("Tell me a long story about a lighthouse keeper who finds a message in a bottle")
    chat.say("Shorter, please")

    assert_equal "Tell me a long story about a lighthouse keeper who finds ...", chat.reload.title
    calls = sidecar_calls(:submit)
    assert_equal [ 900009, "Shorter, please" ], calls.last[1]
    assert_equal 2, calls.map { |call| call[2][:request_id] }.uniq.size
    assert calls.all? { |call| call[2][:request_id].match?(/\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/) }
  end

  test "say on a named chat counts as activity" do
    stub_sidecar(submit: sidecar_accepts_submission)
    chat = chats(:failed)

    assert_changes -> { chat.reload.updated_at } do
      chat.say("Hello?")
    end
    assert_equal "Are you there?", chat.title
  end

  test "stop aborts the run" do
    stub_sidecar(abort: { "ok" => true })
    chats(:poem).stop
    assert_equal [ [ :abort, [ 900002 ], {} ] ], sidecar_calls
  end

  test "reads the transcript and live state from the conversation" do
    assert_equal %w[ pi.user pi.assistant pi.tool-result pi.assistant ], chats(:invoice).transcript.map(&:kind)
    assert chats(:poem).busy?
    assert_equal "Roses are red", DurableAgent::MessageText.text(chats(:poem).streaming_message)
    assert_equal "no_model", chats(:failed).last_failure.reason
  end
end
