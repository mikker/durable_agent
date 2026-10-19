module DurableAgent
  class ApplicationRecord < DurableAgent.config.parent_record_class.to_s.constantize
    self.abstract_class = true
  end
end
