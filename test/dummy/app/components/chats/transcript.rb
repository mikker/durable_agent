# frozen_string_literal: true

# The visible entries of a chat, or the invitation to say hello. Rendered on the page and again in every change
# broadcast, which morphs it in place.
class Components::Chats::Transcript < Components::Base
  def initialize(chat:, entries:)
    @chat, @entries = chat, entries
  end

  def view_template
    div(id: "entries", data: { ui: "transcript" }) do
      if @entries.empty? && !@chat.busy?
        EmptyState(title: "Say hello", description: "Your messages and the agent's answers appear here.")
      else
        @entries.each { |entry| render Components::Chats::Entry.new(entry: entry) }
      end
    end
  end
end
