# Durable work inside a conversation: a run, a tool call, a compaction. `kind` is the task definition's name.
class DurableAgent::Task < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  attribute :record, :json

  belongs_to :conversation

  scope :of_kind, ->(kind) { where(kind: kind.to_s.to_json) }
  scope :unfinished, -> { where.not(status: "terminal") }

  def kind = JSON.parse(super)

  def terminal? = status == "terminal"
  def abort_requested? = abort_requested == 1
  def background? = background == 1
end
