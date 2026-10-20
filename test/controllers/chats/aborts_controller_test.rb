require "test_helper"

class Chats::AbortsControllerTest < ActionDispatch::IntegrationTest
  test "create stops the run" do
    fake_sidecar
    post chat_abort_path(chats(:poem))
    assert_redirected_to chat_path(chats(:poem))
    assert_equal [ 900002 ], sidecar_calls(:abort).sole[1]
  end
end
