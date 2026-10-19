module DurableAgent
  # Set while a tool runs, so the tool (and anything it calls) knows which conversation asked.
  class Current < ActiveSupport::CurrentAttributes
    attribute :conversation_id, :call_id
  end
end
