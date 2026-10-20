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

  # The sidecar creates the root conversation (id 1) at boot, before any app asks for one.
  ROOT_ID = 1

  scope :top_level, -> { where(owner_conversation_id: nil).where.not(id: ROOT_ID) }

  def self.root = find_by(id: ROOT_ID)

  def root? = id == ROOT_ID

  # The sidecar fills created_at from the column default when it inserts the row.
  def last_activity_at
    entries.maximum(:created_at) || created_at
  end

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
  def agent = document("pi.agent")

  # The model this conversation runs on, "provider/modelId", pinned when it was started. The sidecar's default
  # model only applies to conversations started without one.
  def model
    ref = agent["model"]
    "#{ref["provider"]}/#{ref["modelId"]}" if ref
  end

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

  # The newest input that settled without an answer, if it is more recent than the last answer. An assistant
  # entry that ended in an error or an abort is not an answer.
  def last_failure
    failure = submissions.unanswered.reverse_chronologically.first
    return unless failure

    last_answer = entries.reverse_chronologically.of_kind("pi.assistant").find(&:answer?)
    failure if last_answer.nil? || failure.entry_id.to_i > last_answer.id
  end

  # pi.usage: tokens and cost per model over the whole conversation, and per tool.
  def usage = document("pi.usage")
  def usage_by_model = usage.fetch("models", {})
  def total_tokens = usage_by_model.values.sum { |model| model["totalTokens"].to_i }
  def total_cost = usage_by_model.values.sum { |model| model.dig("cost", "total").to_f }

  # The sidecar commits the submission before it answers, so the row is there to find.
  # Both clear the query cache, so busy?, live and transcript read what the sidecar committed.
  def say(content, request_id:, when_busy: nil)
    response = DurableAgent.client.submit(id, content, request_id: request_id, when_busy: when_busy)
    DurableAgent.changed_by_sidecar
    submissions.find(response.fetch("id"))
  end

  def abort
    DurableAgent.client.abort(id).tap { DurableAgent.changed_by_sidecar }
  end
end
