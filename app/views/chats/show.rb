# frozen_string_literal: true

# A chat, live: the page subscribes to its conversation, the sidecar posts a change event to Puma after every
# commit, and Chat#broadcast_changes morphs the transcript, the live region and the composer in place.
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
          @chat.live_regions(entries).each { |component| render component }
        end
      end
    end
  end
end
