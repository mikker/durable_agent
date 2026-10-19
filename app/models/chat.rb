# A chat is a durable_agent conversation with a title. The transcript, the streaming answer and every failure live
# in the durable_agent_* tables, which the sidecar writes; this record is the product's handle on them.
class Chat < ApplicationRecord
  DEFAULT_TITLE = "New chat"

  belongs_to :conversation, class_name: "DurableAgent::Conversation", foreign_key: :durable_agent_conversation_id

  # Newest activity first, as Conversation#last_activity_at defines it: the newest entry's created_at, else the
  # conversation's own.
  scope :by_last_activity, -> do
    joins(:conversation).order(Arel.sql(<<~SQL.squish), id: :desc)
      COALESCE((SELECT MAX(created_at) FROM durable_agent_entries WHERE conversation_id = chats.durable_agent_conversation_id),
        durable_agent_conversations.created_at) DESC
    SQL
  end

  delegate :transcript, :busy?, :streaming_message, :running_tools, :inbox, :last_failure, :last_activity_at, to: :conversation

  # Creates the conversation on the sidecar (which commits its row before answering), then the chat.
  def self.start
    create!(title: DEFAULT_TITLE, conversation: DurableAgent.start)
  end

  # Hands the message to the sidecar. The first message names the chat.
  def say(content)
    conversation.say(content, request_id: SecureRandom.uuid).tap do
      update!(title: content.squish.truncate(60)) if title == DEFAULT_TITLE
    end
  end

  def stop
    conversation.abort
  end
end
