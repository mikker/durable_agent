# A base (the whole value) or a delta (chord ops) of a document, in commit order.
class DurableAgent::Document::Revision < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  self.table_name = "durable_agent_document_revisions"
  self.primary_key = [ :document_id, :seq ]

  belongs_to :document

  def base? = kind == "base"
  def delta? = kind == "delta"

  def value
    JSON.parse(content) if base?
  end
end
