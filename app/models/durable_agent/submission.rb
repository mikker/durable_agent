# Something Rails handed to a conversation: queued, placed as an entry, then done (answered) or unanswered.
# `request_id` is the id Rails chose, so a retried request finds the same submission.
class DurableAgent::Submission < DurableAgent::ApplicationRecord
  include DurableAgent::Mirrored

  self.inheritance_column = nil # `type` is pi's: "input" or "write"

  belongs_to :conversation
  belongs_to :entry, optional: true
  belongs_to :answer, class_name: "DurableAgent::Entry", foreign_key: :answer_entry_id, optional: true

  scope :chronologically, -> { order(:id) }
  scope :reverse_chronologically, -> { order(id: :desc) }
  scope :pending, -> { where(status: %w[ queued placed ]) }
  scope :settled, -> { where(status: %w[ done unanswered ]) }
  scope :unanswered, -> { where(status: "unanswered") }

  # Why an input went unanswered, for people. pi-durable reasons: no_model, run_failed, aborted, withdrawn...
  REASONS = {
    "no_model" => "No model could run. The configured model id may be unknown, or the provider is not connected.",
    "run_failed" => "The model request failed.",
    "aborted" => "The run was stopped."
  }.freeze

  def explanation
    REASONS.fetch(reason.to_s) { "The agent did not answer (#{reason})." }
  end

  def pending? = status.in?(%w[ queued placed ])
  def done? = status == "done"
  def unanswered? = status == "unanswered"
end
