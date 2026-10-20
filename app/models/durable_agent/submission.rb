# Something Rails handed to a conversation: queued, placed as an entry, then done (answered) or unanswered.
# `request_id` is the id Rails chose, so a retried request finds the same submission. pi-durable stores it
# JSON-encoded ("\"42\""), as JSON.stringify writes it, so lookups encode it the same way.
class DurableAgent::Submission < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  attribute :record, :json

  belongs_to :conversation

  scope :chronologically, -> { order(:id) }
  scope :reverse_chronologically, -> { order(id: :desc) }
  scope :pending, -> { where(status: %w[ queued placed ]) }
  scope :settled, -> { where(status: %w[ done unanswered ]) }
  scope :unanswered, -> { where(status: "unanswered") }
  scope :for_request, ->(request_id) { where(request_id: DurableAgent::IndexedString.encode(request_id)) }

  # Why an input went unanswered, for people. pi-durable reasons: no_model, run_failed, aborted, withdrawn...
  REASONS = {
    "no_model" => "No model could run: the conversation has none, or the sidecar does not know its model id.",
    "model_error" => "The model returned an error.",
    "run_failed" => "The run failed.",
    "aborted" => "The run was stopped."
  }.freeze

  def request_id
    DurableAgent::IndexedString.decode(super) if super
  end

  def type = record["type"] # "input" or "write"
  def entry_id = record["entry"]
  def answer_entry_id = record["answer"]
  def reason = record["reason"]
  def detail = record["detail"]

  def entry = DurableAgent::Entry.find_by(id: entry_id)
  def answer = DurableAgent::Entry.find_by(id: answer_entry_id)

  # The detail pi-durable recorded: a string for model_error (the provider's message), a hash for run_failed.
  def detail_text
    detail.is_a?(Hash) ? detail["message"] : detail.presence
  end

  # no_model names the conversation's pinned model when it has one: the sidecar does not register that provider, or
  # the id is not in its catalog. pi-durable records no detail for it. model_error and run_failed carry theirs.
  def explanation
    if reason == "no_model" && (model = conversation&.model)
      "Model #{model} is not available on the sidecar. Its provider is not registered, or the model id is unknown."
    else
      [ REASONS.fetch(reason.to_s) { "The agent did not answer (#{reason})." }, detail_text ].compact.join(" ")
    end
  end

  def pending? = status.in?(%w[ queued placed ])
  def done? = status == "done"
  def unanswered? = status == "unanswered"
end
