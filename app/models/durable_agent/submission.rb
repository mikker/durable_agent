# Something Rails handed to a conversation: queued, placed as an entry, then done (answered) or unanswered.
# `request_id` is the id Rails chose, so a retried request finds the same submission. pi-durable stores it
# JSON-encoded ("\"42\""), so lookups encode it too.
class DurableAgent::Submission < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  attribute :record, :json

  belongs_to :conversation

  scope :chronologically, -> { order(:id) }
  scope :reverse_chronologically, -> { order(id: :desc) }
  scope :pending, -> { where(status: %w[ queued placed ]) }
  scope :settled, -> { where(status: %w[ done unanswered ]) }
  scope :unanswered, -> { where(status: "unanswered") }
  scope :for_request, ->(request_id) { where(request_id: request_id.to_s.to_json) }

  # Why an input went unanswered, for people. pi-durable reasons: no_model, run_failed, aborted, withdrawn...
  REASONS = {
    "no_model" => "No model could run. The configured model id may be unknown, or the provider is not connected.",
    "run_failed" => "The model request failed.",
    "aborted" => "The run was stopped."
  }.freeze

  def request_id
    JSON.parse(super) if super
  end

  def type = record["type"] # "input" or "write"
  def entry_id = record["entry"]
  def answer_entry_id = record["answer"]
  def reason = record["reason"]
  def detail = record["detail"]

  def entry = DurableAgent::Entry.find_by(id: entry_id)
  def answer = DurableAgent::Entry.find_by(id: answer_entry_id)

  def explanation
    REASONS.fetch(reason.to_s) { "The agent did not answer (#{reason})." }
  end

  def pending? = status.in?(%w[ queued placed ])
  def done? = status == "done"
  def unanswered? = status == "unanswered"
end
