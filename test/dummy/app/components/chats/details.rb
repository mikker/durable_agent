# frozen_string_literal: true

# The chat's own numbers, collapsed under the title: which model it runs on, what it is doing, when, how much it has
# consumed. Everything comes from the conversation's rows and its pi.agent and pi.usage documents.
class Components::Chats::Details < Components::Base
  STATUS = { busy: [ "Thinking", :info ], failed: [ "Failed", :destructive ], idle: [ "Idle", :neutral ] }.freeze

  def initialize(chat:, entries:)
    @chat, @entries = chat, entries
  end

  def view_template
    conversation = @chat.conversation

    Accordion(id: dom_id(@chat, :details)) do |accordion|
      accordion.item(:details, title: "Details") do
        DetailsTable(@chat, label: "Chat details") do |table|
          table.field(:model, value: @chat.model) { |model| model ? code { model } : em { "sidecar default, set when the first message runs" } }
          table.field(:status, value: @chat.status) { |status| Badge(STATUS.fetch(status).first, size: :sm, color: STATUS.fetch(status).last) }
          table.field(:conversation, value: conversation.id)
          table.field(:started, value: conversation.created_at)
          table.field(:last_activity, value: conversation.last_activity_at)
          table.field(:messages, value: message_counts)
          table.field(:tokens, value: @chat.total_tokens) { |total| tokens(total) }
          table.field(:cost, value: number_to_currency(@chat.total_cost, precision: 4))
        end
      end
    end
  end

  private
    def message_counts
      user, answers, tools = @entries.count(&:user?), @entries.count(&:answer?), @entries.sum { |entry| entry.tool_calls.size }
      failed = @entries.count(&:failed?)
      parts = [ "#{user} from you", "#{answers} #{"answer".pluralize(answers)}", "#{tools} tool #{"call".pluralize(tools)}" ]
      parts << "#{failed} failed" if failed.positive?
      parts.join(", ")
    end

    # The total, then each model's share when more than one answered.
    def tokens(total)
      plain "#{number_with_delimiter(total)} total"
      by_model = @chat.usage_by_model
      return if by_model.size < 2

      ul do
        by_model.each do |model, usage|
          li { "#{model}: #{number_with_delimiter(usage["totalTokens"].to_i)} (#{number_with_delimiter(usage["input"].to_i)} in, #{number_with_delimiter(usage["output"].to_i)} out, #{number_with_delimiter(usage["cacheRead"].to_i)} cached)" }
        end
      end
    end
end
