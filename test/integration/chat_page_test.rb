require "test_helper"

# Renders a whole chat from the durable_agent_* fixture rows, the way a browser sees it after a refresh.
class ChatPageTest < ActionDispatch::IntegrationTest
  setup { stub_sidecar(auth: CONNECTED) }

  test "a finished chat shows the transcript with tools collapsed, a live subscription and the composer" do
    chat = chats(:invoice)
    get chat_path(chat)
    assert_response :success

    assert_select "title", chat.title
    assert_select "h1", chat.title
    assert_select "turbo-cable-stream-source[signed-stream-name]", 1
    assert_select "meta[name=turbo-refresh-method][content=morph]"
    assert_select "meta[name=turbo-refresh-scroll][content=preserve]"

    assert_select "#entries article[data-ui=entry]", 4 # the pi.system entry is hidden
    assert_select "#entries", text: /You are the assistant/, count: 0
    assert_select "#entries article[data-role=user]", text: /What is invoice INV-1\?/
    assert_select "#entries article[data-role=assistant]", text: /Let me look\./
    assert_select "#entries article[data-role=assistant] details[data-ui=tool]:not([open]) summary", text: /lookup_invoice call/
    assert_select "#entries article[data-role=assistant] details pre", text: /"number": "INV-1"/
    assert_select "#entries article[data-role=tool] details[data-ui=tool]:not([open]) summary", text: /lookup_invoice result/
    assert_select "#entries article[data-role=assistant]", text: /INV-1 totals 42\./

    assert_select "#live:empty"
    assert_select "form[action=?] textarea[name='message[content]']", chat_messages_path(chat)
    assert_select "button", text: "Send"
    assert_select "button", text: "Stop", count: 0
  end

  test "the stream is the conversation the sidecar's change events refresh" do
    chat = chats(:invoice)
    get chat_path(chat)
    stream = css_select("turbo-cable-stream-source").first["signed-stream-name"]
    assert_equal Turbo::StreamsChannel.signed_stream_name(chat.conversation), stream

    assert_turbo_stream_broadcasts chat.conversation do
      DurableAgent.config.on_change.call(chat.conversation)
    end
  end
end
