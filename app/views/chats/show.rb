# frozen_string_literal: true

# A chat, live: the page subscribes to its conversation, the sidecar posts a change event to Puma after every
# commit, and the default on_change callback broadcasts a Turbo refresh that morphs this page.
class Views::Chats::Show < Views::Base
  def initialize(chat:, connection:)
    @chat, @connection = chat, connection
  end

  def view_template
    content_for(:title, @chat.title)
    render Components::Shell.new(title: @chat.title, current: :chats, back: { label: "Back to chats", href: chats_path }) do
      turbo_stream_from @chat.conversation

      entries = @chat.transcript

      Container(size: :lg) do
        Flex(dir: :col, gap: 6, align: :stretch) do
          render Components::ConnectionNotice.new(connection: @connection)
          render Components::Chats::Details.new(chat: @chat, entries: entries)
          transcript(entries)
          render Components::Chats::Live.new(conversation: @chat.conversation, failure_shown_inline: entries.last&.failed? || false)
          render Components::Chats::Composer.new(chat: @chat)
        end
      end
    end
  end

  private
    def transcript(entries)
      div(id: "entries", data: { ui: "transcript" }) do
        if entries.empty? && !@chat.busy?
          EmptyState(title: "Say hello", description: "Your messages and the agent's answers appear here.")
        else
          entries.each { |entry| render Components::Chats::Entry.new(entry: entry) }
        end
      end
    end
end
