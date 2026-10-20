require "test_helper"

class RenameChatTest < ActiveSupport::TestCase
  test "renames the chat of the conversation that asked" do
    chat = chats(:poem)

    result = DurableAgent::Current.set(conversation_id: chat.durable_agent_conversation_id, call_id: "call-1") do
      RenameChat.run({ "title" => "  A poem about   roses  " })
    end

    assert_equal({ id: chat.id, title: "A poem about roses" }, result)
    assert_equal "A poem about roses", chat.reload.title
  end

  test "truncates long titles, refuses blank ones, and is not replay-safe" do
    chat = chats(:poem)
    DurableAgent::Current.set(conversation_id: chat.durable_agent_conversation_id) do
      RenameChat.run({ "title" => "x" * 80 })
      assert_equal 60, chat.reload.title.length
      assert_raises(ArgumentError) { RenameChat.run({ "title" => " " }) }
    end

    assert_raises(ActiveRecord::RecordNotFound) do
      DurableAgent::Current.set(conversation_id: 1) { RenameChat.run({ "title" => "Orphan" }) }
    end
    assert_equal "unsafe", RenameChat.to_definition[:replay]
  end
end
