# frozen_string_literal: true

# One visible transcript entry. Tool calls and results are collapsed; `data-role` lets CSS align user messages.
# Each entry ends in a meta line with what pi-ai recorded on it: time, model, duration, tokens, cost.
class Components::Chats::Entry < Components::Base
  def initialize(entry:)
    @entry = entry
  end

  def view_template
    article(id: dom_id(@entry), data: { ui: "entry", role: role }) do
      if @entry.user? then user_message
      elsif @entry.failed? then failed_answer
      elsif @entry.assistant? then assistant_message
      elsif @entry.tool_result? then tool_result
      elsif @entry.compaction? then Badge("Context compacted", size: :sm)
      else other
      end
      meta
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

    # The model request ended in an error or was stopped: pi-ai keeps the message with the reason and no content.
    def failed_answer
      if @entry.stop_reason == "aborted"
        Alert(variant: :warning, title: "Stopped", description: "The answer was stopped before it finished.")
      else
        Flex(dir: :col, gap: 2, align: :start) do
          Alert(variant: :destructive, title: "Model error", description: @entry.error_message.presence || "The model request failed.")
          if @entry.error_message.to_s.match?(/OAuth|invalid_grant|401|403/)
            Button("Sign in with ChatGPT again", href: settings_chatgpt_connection_path, size: :sm, icon: :log_in)
          end
        end
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

    # Time, then for an assistant entry the model, how long the request took, tokens and cost, and how it stopped.
    def meta
      at = @entry.timestamp || @entry.created_at
      items = []
      items << at.strftime("%H:%M:%S") if at
      if @entry.assistant?
        items << @entry.model_ref if @entry.model_ref
        items << "#{(@entry.duration_ms / 1000.0).round(1)} s" if @entry.duration_ms
        items << "#{number_with_delimiter(@entry.total_tokens)} tokens" if @entry.total_tokens
        items << number_to_currency(@entry.cost, precision: 4) if @entry.cost
        items << "stopped: #{@entry.stop_reason}" if @entry.stop_reason.present? && @entry.stop_reason != "stop"
      elsif @entry.tool_result?
        items << @entry.tool_name if @entry.tool_name.present?
      end
      return if items.empty?

      footer(data: { ui: "meta" }) do
        items.each_with_index do |item, index|
          span(aria: { hidden: true }) { "·" } if index.positive?
          if index.zero? && at
            time(datetime: at.iso8601, title: at.iso8601) { item }
          else
            span { item }
          end
        end
      end
    end
end
