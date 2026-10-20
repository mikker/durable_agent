# One immutable transcript record. `kind` is pi's (`pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`,
# `pi.reset`, `pi.compaction`) or an application kind. `model` holds the messages the model sees; `data` is the
# application payload. All of it lives in the `record` JSON, so kind filtering happens in Ruby.
class DurableAgent::Entry < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  HIDDEN_KINDS = %w[ pi.system pi.reset ].freeze

  attribute :record, :json

  belongs_to :conversation

  scope :chronologically, -> { order(:id) }
  scope :reverse_chronologically, -> { order(id: :desc) }

  def self.visible = all.select(&:visible?)
  def self.of_kind(*kinds) = all.select { |entry| entry.kind.in?(kinds.flatten) }

  def kind = record["kind"]
  def data = record["data"]
  def model = record["model"]
  def head = record["head"]
  def by_task_id = record["byTaskId"]

  def visible? = !kind.in?(HIDDEN_KINDS)
  def user? = kind == "pi.user"
  def assistant? = kind == "pi.assistant"
  def tool_result? = kind == "pi.tool-result"
  def compaction? = kind == "pi.compaction"

  def messages = Array.wrap(model)
  def text = DurableAgent::MessageText.text(messages)
  def tool_calls = DurableAgent::MessageText.tool_calls(messages)
  def thinking? = DurableAgent::MessageText.thinking?(messages)

  def tool_name = messages.first&.dig("toolName")
  def error? = messages.any? { |message| message["isError"] }

  # What pi-ai records on each message: the model that answered, how it stopped, tokens, timing.
  def message = messages.first || {}
  def provider = message["provider"]
  def model_id = message["model"] # not model_name, which is Active Model's
  def model_ref = ("#{provider}/#{model_id}" if provider && model_id)
  def stop_reason = message["stopReason"] # "stop", "length", "toolUse", "aborted", "error"
  def error_message = message["errorMessage"]
  def usage = message["usage"] || {}
  def total_tokens = usage["totalTokens"]
  def cost = usage.dig("cost", "total")
  def duration_ms = message["durationMs"]
  def timestamp = (Time.zone.at(message["timestamp"] / 1000.0) if message["timestamp"])

  # An assistant entry the model request ended in an error or an abort: it carries no answer, and the input it was
  # for settles unanswered.
  def failed? = assistant? && stop_reason.in?(%w[ error aborted ])
  def answer? = assistant? && !failed?
end
