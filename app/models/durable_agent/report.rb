# A failure the harness reported without failing the operation: a faulted or parked task, a hook error, a
# failed session. Show these to operators.
class DurableAgent::Report < DurableAgent::ApplicationRecord
  include DurableAgent::Mirrored

  self.inheritance_column = nil

  belongs_to :conversation, optional: true

  scope :reverse_chronologically, -> { order(id: :desc) }
  scope :latest, -> { reverse_chronologically.limit(20) }
end
