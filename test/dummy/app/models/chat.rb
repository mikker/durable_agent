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

  delegate :transcript, :busy?, :streaming_message, :running_tools, :inbox, :last_failure, :last_activity_at,
    :model, :usage_by_model, :total_tokens, :total_cost, to: :conversation

  # What the chat is doing: :busy while a run is on, :failed when the last input went unanswered, else :idle.
  def status
    if busy? then :busy
    elsif last_failure then :failed
    else :idle
    end
  end

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

  # The sidecar's change event for a conversation, from config.on_change: morph the regions that change while the
  # agent works, instead of refreshing the page. Conversations without a chat (none today) broadcast nothing.
  def self.changed(conversation)
    find_by(durable_agent_conversation_id: conversation.id)&.broadcast_changes
  end

  # One stream message replacing #entries, #live and #composer with method="morph", so open tool details,
  # focus and the draft message survive. The page renders the same components in the same order.
  def broadcast_changes
    content = live_regions.map { |component| replace_tag(component) }.join
    Turbo::StreamsChannel.broadcast_stream_to(conversation, content: content)
  end

  def live_regions(entries = transcript)
    [
      Components::Chats::Transcript.new(chat: self, entries: entries),
      Components::Chats::Live.new(conversation: conversation, failure_shown_inline: entries.last&.failed? || false),
      Components::Chats::Composer.new(chat: self)
    ]
  end

  private
    REGION_IDS = { Components::Chats::Transcript => "entries", Components::Chats::Live => "live", Components::Chats::Composer => "composer" }.freeze

    def replace_tag(component)
      html = ApplicationController.render(component, layout: false)
      ApplicationController.helpers.turbo_stream_action_tag(:replace, target: REGION_IDS.fetch(component.class), template: html, method: :morph)
    end
end
