require "test_helper"

class Chats::MessagesControllerTest < ActionDispatch::IntegrationTest
  test "create hands the message to the sidecar and redirects back to the chat" do
    fake_sidecar
    post chat_messages_path(chats(:invoice)), params: { message: { content: "  More please  " } }
    assert_redirected_to chat_path(chats(:invoice))
    assert_response :see_other
    call = sidecar_calls(:submit).sole
    assert_equal [ 900001, "More please" ], call[1]
    assert call[2][:request_id].present?
    assert_equal "queued", chats(:invoice).conversation.submissions.for_request(call[2][:request_id]).sole.status
  end

  test "create ignores a blank message" do
    fake_sidecar
    post chat_messages_path(chats(:invoice)), params: { message: { content: " " } }
    assert_redirected_to chat_path(chats(:invoice))
    assert_empty sidecar_calls(:submit)
  end

  test "create explains an unreachable sidecar" do
    stub_sidecar(submit: DurableAgent::Unavailable)
    post chat_messages_path(chats(:invoice)), params: { message: { content: "Hello" } }, headers: { "Referer" => chat_url(chats(:invoice)) }
    assert_redirected_to chat_url(chats(:invoice))
    assert_equal "The agent sidecar is not running.", flash[:alert]
  end
end
