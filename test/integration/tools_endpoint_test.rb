require "test_helper"

# The gem's tools endpoint, as the sidecar calls it: definitions at boot, then one POST per tool call.
class ToolsEndpointTest < ActionDispatch::IntegrationTest
  setup { @headers = { "Authorization" => "Bearer #{DurableAgent.config.token}", "Content-Type" => "application/json" } }

  test "the sidecar fetches the three tools' definitions" do
    get "/durable_agent/tools", headers: @headers
    assert_response :success
    assert_equal %w[ current_time search_chats rename_chat ], response.parsed_body.map { it["name"] }
    assert_equal %w[ safe safe unsafe ], response.parsed_body.map { it["replay"] }
  end

  test "a tool call renames the chat of the conversation that asked" do
    chat = chats(:poem)
    post "/durable_agent/tools/rename_chat", headers: @headers,
      params: { arguments: { title: "Roses" }, conversation_id: chat.durable_agent_conversation_id, call_id: "call-9" }.to_json
    assert_response :success
    assert_equal({ "result" => { "id" => chat.id, "title" => "Roses" } }, response.parsed_body)
    assert_equal "Roses", chat.reload.title
  end

  test "a bad argument reaches the model as an error result, without the token nothing does" do
    post "/durable_agent/tools/search_chats", headers: @headers, params: { arguments: { query: " " } }.to_json
    assert_response :unprocessable_content
    assert_equal "query must not be blank", response.parsed_body["error"]

    get "/durable_agent/tools"
    assert_response :unauthorized
  end
end
