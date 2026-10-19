# frozen_string_literal: true

# What the agent is doing right now: the streaming partial answer, running tools and queued inputs, or why the
# last input went unanswered. Empty when there is nothing to say.
class Components::Chats::Live < Components::Base
  def initialize(conversation:)
    @conversation = conversation
  end

  def view_template
    div(id: "live", data: { ui: "live" }) do
      if @conversation.busy?
        busy
      elsif (failure = @conversation.last_failure)
        Alert(variant: :destructive, title: "No answer", description: failure.explanation)
      end
    end
  end

  private
    def busy
      text = DurableAgent::MessageText.text(@conversation.streaming_message)

      article(data: { ui: "entry", role: "assistant" }) do
        Flex(dir: :col, gap: 2, align: :stretch) do
          Flex(dir: :row, gap: 2, align: :center, wrap: :wrap) do
            Badge(text.present? ? "Writing…" : "Thinking…", size: :sm, color: :info)
            @conversation.running_tools.each { |tool| Badge(tool["name"].to_s, size: :sm, color: :warning) }
            queued = @conversation.inbox.size
            Badge("#{queued} queued", size: :sm, variant: :outline) if queued.positive?
          end
          Typeset { simple_format(text) } if text.present?
        end
      end
    end
end
