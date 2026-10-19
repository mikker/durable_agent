# A pi-durable conversation, read straight from the harness tables. The sidecar writes the rows; Rails reads them
# and sends commands through DurableAgent.client. Your own record (a Chat, a Ticket) holds the conversation id.
class DurableAgent::Conversation < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  attribute :record, :json

  # Own rows only: a forked conversation's inherited entries are not followed.
  has_many :entries, dependent: nil
  has_many :submissions, dependent: nil
  has_many :tasks, dependent: nil
  has_many :reports, dependent: nil
  has_many :documents, -> { current.where(scope_kind: "conversation") }, foreign_key: :owner_id, dependent: nil
  belongs_to :owner, class_name: "DurableAgent::Conversation", foreign_key: :owner_conversation_id, optional: true

  scope :top_level, -> { where(owner_conversation_id: nil) }

  def parent
    DurableAgent::Conversation.find_by(id: record.dig("parent", "conversationId")) if record["parent"]
  end

  # The entry of the parent conversation through which this one inherits history.
  def parent_at
    DurableAgent::Entry.find_by(id: record.dig("parent", "at")) if record["parent"]
  end

  def document(kind)
    documents.of_kind(kind).first&.value || {}
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
    entries.chronologically.visible
  end

  # The newest input that settled without an answer, if it is more recent than the last answer.
  def last_failure
    failure = submissions.unanswered.reverse_chronologically.first
    return unless failure

    last_answer = entries.reverse_chronologically.of_kind("pi.assistant").first
    failure if last_answer.nil? || failure.entry_id.to_i > last_answer.id
  end

  # The sidecar commits the submission before it answers, so the row is there to find.
  def say(content, request_id:, when_busy: nil)
    response = DurableAgent.client.submit(id, content, request_id: request_id, when_busy: when_busy)
    submissions.find(response.fetch("id"))
  end

  def abort
    DurableAgent.client.abort(id)
  end
end
