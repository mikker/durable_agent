# Current value of one conversation document: pi.agent, pi.live, pi.inbox, pi.usage, pi.provider.
class DurableAgent::Document < DurableAgent::ApplicationRecord
  include DurableAgent::Mirrored

  self.primary_key = [ :conversation_id, :kind ]

  belongs_to :conversation
end
