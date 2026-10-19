require "test_helper"

class ChatsControllerTest < ActionDispatch::IntegrationTest
  setup { stub_sidecar(auth: CONNECTED) }

  test "index lists chats, newest activity first, with a New chat button" do
    get chats_path
    assert_response :success
    assert_select "h1", "Chats"
    assert_select "[data-nk=table] tbody tr", 3
    assert_select "[data-nk=table] tbody tr:first-child a[href=?]", chat_path(chats(:invoice)), text: "What is invoice INV-1?"
    assert_select "[data-nk=table] time", text: /ago\z/
    assert_select "form[action=?][method=post] button", chats_path, text: "New chat"
    assert_select "[data-nk=alert]", count: 0
  end

  test "index shows the empty state and asks to connect ChatGPT" do
    Chat.delete_all
    stub_sidecar(auth: DISCONNECTED)
    get chats_path
    assert_select "[data-nk=empty-state]", /No chats yet/
    assert_select "[data-nk=alert]", /Connect ChatGPT/
  end

  test "index says when the sidecar is unreachable" do
    stub_sidecar(auth: DurableAgent::Unavailable.new(nil, nil, "sidecar unreachable at http://127.0.0.1:4010"))
    get chats_path
    assert_response :success
    assert_select "[data-nk=alert]", /Agent sidecar unreachable/
  end

  test "index orders chats by their conversation's last activity" do
    get chats_path
    rows = css_select("[data-nk=table] tbody tr th a").map(&:text)
    assert_equal [ chats(:invoice), chats(:poem), chats(:failed) ].map(&:title), rows
    assert_select "tr##{dom_id(chats(:poem))} time[datetime=?]", chats(:poem).last_activity_at.iso8601, text: "about 1 hour ago"
  end

  test "create starts a chat and redirects to it" do
    fake_sidecar
    assert_difference -> { Chat.count }, 1 do
      post chats_path
    end
    assert_redirected_to chat_path(Chat.last)
    assert_response :see_other
    assert_equal 1, sidecar_calls(:create_conversation).size
    assert DurableAgent::Conversation.exists?(Chat.last.durable_agent_conversation_id)
  end

  test "create explains an unreachable sidecar" do
    stub_sidecar(create_conversation: DurableAgent::Unavailable)
    assert_no_difference -> { Chat.count } do
      post chats_path
    end
    assert_redirected_to root_path
    assert_equal "The agent sidecar is not running.", flash[:alert]
  end

  test "create says when the sidecar is still starting" do
    stub_sidecar(create_conversation: DurableAgent::Unavailable.new(503, { "error" => "starting" }, "sidecar is starting"))
    post chats_path
    assert_redirected_to root_path
    assert_equal "The agent sidecar is starting. Try again in a moment.", flash[:alert]
  end

  test "show while busy streams the partial answer, lists running tools and offers Stop" do
    get chat_path(chats(:poem))
    assert_response :success
    assert_select "#entries article[data-role=user]", text: /Write me a poem/
    assert_select "#live", /Thinking…|Writing…/
    assert_select "#live", /Roses are red/
    assert_select "#live [data-nk=badge]", text: "lookup_invoice"
    assert_select "#live [data-nk=badge]", text: "1 queued"
    assert_select "button[form=?]", "abort_chat_#{chats(:poem).id}", text: "Stop"
    assert_select "form#abort_chat_#{chats(:poem).id}[action=?]", chat_abort_path(chats(:poem))
  end

  test "show explains the last unanswered input" do
    get chat_path(chats(:failed))
    assert_select "#live [data-nk=alert]", /No model could run/
    assert_select "button", text: "Stop", count: 0
  end

  test "show of a new chat invites the first message" do
    fake_sidecar
    get chat_path(Chat.start)
    assert_select "#entries [data-nk=empty-state]", /Say hello/
    assert_select "#live:empty"
  end
end
