# frozen_string_literal: true

# One visible transcript entry. Tool calls and results are collapsed; `data-role` lets CSS align user messages.
class Components::Chats::Entry < Components::Base
  def initialize(entry:)
    @entry = entry
  end

  def view_template
    article(id: dom_id(@entry), data: { ui: "entry", role: role }) do
      if @entry.user? then user_message
      elsif @entry.assistant? then assistant_message
      elsif @entry.tool_result? then tool_result
      elsif @entry.compaction? then Badge("Context compacted", size: :sm)
      else other
      end
    end
  end

  private
    def role
      if @entry.user? then "user"
      elsif @entry.tool_result? then "tool"
      else "assistant"
      end
    end

    def user_message
      Card(size: :sm, variant: :muted) do |card|
        card.body { Typeset { simple_format(@entry.text) } }
      end
    end

    def assistant_message
      Flex(dir: :col, gap: 2, align: :stretch) do
        Typeset { simple_format(@entry.text) } if @entry.text.present?
        @entry.tool_calls.each { |call| tool_call(call) }
      end
    end

    def tool_call(call)
      details(data: { ui: "tool" }) do
        summary do
          Badge(call["name"].to_s, size: :sm, color: :info)
          plain " call"
        end
        pre { code { JSON.pretty_generate(call["arguments"] || {}) } }
      end
    end

    def tool_result
      details(data: { ui: "tool" }) do
        summary do
          Badge(@entry.tool_name.presence || "tool", size: :sm, color: @entry.error? ? :destructive : :neutral)
          plain @entry.error? ? " failed" : " result"
        end
        pre { code { @entry.text } }
      end
    end

    def other
      Badge(@entry.kind.to_s, size: :sm, variant: :outline)
      Typeset { simple_format(@entry.text) } if @entry.text.present?
    end
end
