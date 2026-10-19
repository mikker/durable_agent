# frozen_string_literal: true

class Views::Chats::Index < Views::Base
  def initialize(chats:, connection:)
    @chats, @connection = chats, connection
  end

  def view_template
    content_for(:title, "Chats")
    render Components::Shell.new(title: "Chats", current: :chats, actions: -> { new_chat_button }) do
      Flex(dir: :col, gap: 6, align: :stretch) do
        render Components::ConnectionNotice.new(connection: @connection)
        @chats.any? ? chats_table : empty_state
      end
    end
  end

  private
    def new_chat_button
      ButtonTo("New chat", href: chats_path, variant: :primary, size: :sm, icon: :plus, id: "new-chat")
    end

    def empty_state
      EmptyState(title: "No chats yet", description: "Start one with New chat.") do |empty|
        empty.icon NitroKit::Icon.new(:messages_square, size: :lg)
      end
    end

    def chats_table
      Table(table_aria: { label: "Chats" }) do |table|
        table.thead do
          table.tr do
            table.th("Chat")
            table.th("Last activity")
          end
        end
        table.tbody do
          @chats.each do |chat|
            table.tr(html: { id: dom_id(chat) }) do
              table.th(scope: :row) { a(href: chat_path(chat)) { chat.title } }
              table.td { time(datetime: chat.updated_at.iso8601) { "#{time_ago_in_words(chat.updated_at)} ago" } }
            end
          end
        end
      end
    end
end
