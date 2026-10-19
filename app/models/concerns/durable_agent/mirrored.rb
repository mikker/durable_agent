# Rows the sidecar writes. Rails never changes them; a write here would be overwritten by the next mirror frame.
module DurableAgent::Mirrored
  extend ActiveSupport::Concern

  included do
    self.table_name = "durable_agent_#{model_name.element.pluralize}"
  end

  def readonly? = true
end
