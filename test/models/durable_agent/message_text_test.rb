require "test_helper"

class DurableAgent::MessageTextTest < ActiveSupport::TestCase
  test "joins text blocks and plain string content" do
    messages = [ { "role" => "user", "content" => "Hi" }, { "role" => "assistant", "content" => [ { "type" => "text", "text" => " there" } ] } ]
    assert_equal "Hi there", DurableAgent::MessageText.text(messages)
  end

  test "extracts tool calls and detects thinking" do
    messages = [ { "content" => [ { "type" => "thinking", "thinking" => "..." }, { "type" => "toolCall", "name" => "bash" } ] } ]
    assert_equal [ "bash" ], DurableAgent::MessageText.tool_calls(messages).map { it["name"] }
    assert DurableAgent::MessageText.thinking?(messages)
    assert_equal "", DurableAgent::MessageText.text(messages)
  end

  test "accepts a single message hash, as pi.live stores the streaming partial" do
    assert_equal "Roses are red", DurableAgent::MessageText.text({ "content" => [ { "type" => "text", "text" => "Roses are red" } ] })
    assert_equal "", DurableAgent::MessageText.text(nil)
  end
end
