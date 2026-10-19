# One incarnation of a pi-durable document: pi.agent, pi.live, pi.inbox, pi.usage, pi.provider, or an
# application's. The sidecar stores every document Rails reads as a single base revision (it folds each delta
# into a new base before committing), so the current value is the content of the newest revision.
class DurableAgent::Document < DurableAgent::ApplicationRecord
  include DurableAgent::HarnessRecord

  # The newest revision is a delta: reading it would need a port of chord's delta replay.
  class HistoryNotSupported < StandardError; end

  attribute :record, :json

  has_many :revisions, -> { order(:seq) }, dependent: nil

  scope :current, -> { where(retired_at: nil) }
  scope :of_kind, ->(kind) { where(kind: DurableAgent::IndexedString.encode(kind)) }

  def kind = DurableAgent::IndexedString.decode(super)
  def key = (DurableAgent::IndexedString.decode(key_value) if keyed?)
  def keyed? = family == 1
  def retired? = retired_at.present?

  def value
    newest = revisions.reorder(seq: :desc).first
    raise HistoryNotSupported, "document #{id} (#{kind}) ends in a delta revision" if newest&.delta?
    newest&.value
  end
end
