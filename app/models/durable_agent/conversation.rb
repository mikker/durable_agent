# A pi-durable conversation as the sidecar mirrored it. Rows arrive from the sidecar; Rails reads them and sends
# commands through DurableAgent.client. Your own record (a Chat, a Ticket) holds the conversation id.
class DurableAgent::Conversation < DurableAgent::ApplicationRecord
  include DurableAgent::Mirrored

  has_many :entries, dependent: nil
  has_many :documents, dependent: nil
  has_many :submissions, dependent: nil
  has_many :reports, dependent: nil
  belongs_to :parent, class_name: "DurableAgent::Conversation", foreign_key: :parent_conversation_id, optional: true
  belongs_to :owner, class_name: "DurableAgent::Conversation", foreign_key: :owner_conversation_id, optional: true

  scope :top_level, -> { where(owner_conversation_id: nil) }
  scope :preloaded, -> { includes(:documents) }

  def document(kind)
    documents.find { |document| document.kind == kind }&.body || {}
  end

  def live = document("pi.live")
  def inbox = document("pi.inbox").fetch("items", [])

  def busy?
    live["run"].present?
  end

  def streaming_message
    live.dig("generation", "message")
  end

  def running_tools
    live.fetch("tools", [])
  end

  def transcript
    entries.visible.chronologically
  end

  # The newest input that settled without an answer, if it is more recent than the last answer.
  def last_failure
    failure = submissions.unanswered.reverse_chronologically.first
    return unless failure

    last_answer = entries.of_kind("pi.assistant").reverse_chronologically.first
    failure if last_answer.nil? || failure.entry_id.to_i > last_answer.id
  end

  # The mirror row may not exist yet when the sidecar answers, so an unsaved stand-in carries what it said.
  def say(content, request_id:, when_busy: nil)
    response = DurableAgent.client.submit(id, content, request_id: request_id, when_busy: when_busy)
    submissions.find_by(id: response.fetch("id")) ||
      DurableAgent::Submission.new(id: response.fetch("id"), conversation_id: id, request_id: request_id.to_s,
        type: "input", status: response["status"])
  end

  def abort
    DurableAgent.client.abort(id)
  end
end
