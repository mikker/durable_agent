# An example tool with a side effect: the model renames the chat it is answering in. DurableAgent::Current says
# which conversation asked, so the tool needs no id argument. It is not replay-safe: pi reports a call interrupted
# by a crash instead of running it twice.
class RenameChat < DurableAgent::Tool
  description "Give the current chat a new title"
  param :title, :string, "The new title, at most 60 characters"

  def call(title:)
    raise ArgumentError, "title must not be blank" if title.blank?

    chat = Chat.find_by!(durable_agent_conversation_id: DurableAgent::Current.conversation_id)
    chat.update!(title: title.squish.truncate(60))
    { id: chat.id, title: chat.title }
  end
end
