# A chat is a durable_agent conversation with a title. The transcript, the streaming answer and every failure live
# in the durable_agent_* tables, which the sidecar writes; this record is the product's handle on them.
class Chat < ApplicationRecord
  DEFAULT_TITLE = "New chat"

  belongs_to :conversation, class_name: "DurableAgent::Conversation", foreign_key: :durable_agent_conversation_id

  scope :reverse_chronologically, -> { order(updated_at: :desc, id: :desc) }

  delegate :transcript, :busy?, :streaming_message, :running_tools, :inbox, :last_failure, to: :conversation

  # Creates the conversation on the sidecar (which commits its row before answering), then the chat.
  def self.start
    create!(title: DEFAULT_TITLE, conversation: DurableAgent.start)
  end

  # Hands the message to the sidecar. The first message names the chat; every message counts as activity.
  def say(content)
    conversation.say(content, request_id: SecureRandom.uuid).tap do
      title == DEFAULT_TITLE ? update!(title: content.squish.truncate(60)) : touch
    end
  end

  def stop
    conversation.abort
  end
end
