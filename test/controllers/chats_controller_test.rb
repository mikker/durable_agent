require "test_helper"

class ChatsControllerTest < ActionDispatch::IntegrationTest
  setup { stub_sidecar(auth: SidecarStubs::CONNECTED) }

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
    stub_sidecar(auth: SidecarStubs::DISCONNECTED)
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

  test "create starts a chat and redirects to it" do
    stub_sidecar(create_conversation: sidecar_creates_conversation(900009))
    assert_difference -> { Chat.count }, 1 do
      post chats_path
    end
    assert_redirected_to chat_path(Chat.last)
    assert_response :see_other
    assert_equal 900009, Chat.last.durable_agent_conversation_id
  end

  test "create explains an unreachable sidecar" do
    stub_sidecar(create_conversation: DurableAgent::Unavailable)
    assert_no_difference -> { Chat.count } do
      post chats_path
    end
    assert_redirected_to root_path
    assert_equal "The agent sidecar is not running.", flash[:alert]
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
    stub_sidecar(create_conversation: sidecar_creates_conversation(900009))
    get chat_path(Chat.start)
    assert_select "#entries [data-nk=empty-state]", /Say hello/
    assert_select "#live:empty"
  end
end
