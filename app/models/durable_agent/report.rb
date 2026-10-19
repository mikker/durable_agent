# A failure the harness reported without failing the operation: a faulted or parked task, a hook error, a
# failed session. Show these to operators.
class DurableAgent::Report < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  self.inheritance_column = nil

  attribute :info, :json

  belongs_to :conversation, optional: true

  scope :reverse_chronologically, -> { order(id: :desc) }
  scope :latest, -> { reverse_chronologically.limit(20) }
end
