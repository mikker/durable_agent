# One immutable transcript record. `kind` is pi's (`pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`,
# `pi.reset`, `pi.compaction`) or an application kind. `model` holds the messages the model sees; `data` is the
# application payload.
class DurableAgent::Entry < DurableAgent::ApplicationRecord
  include DurableAgent::Mirrored

  HIDDEN_KINDS = %w[ pi.system pi.reset ].freeze

  belongs_to :conversation

  scope :chronologically, -> { order(:id) }
  scope :reverse_chronologically, -> { order(id: :desc) }
  scope :of_kind, ->(kind) { where(kind: kind) }
  scope :visible, -> { where.not(kind: HIDDEN_KINDS) }

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
end
