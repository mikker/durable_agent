# Rows of pi-durable's own tables, which the sidecar's harness writes. Rails never changes them: a write here
# would bypass the harness and corrupt its state.
module DurableAgent::HarnessRecord
  extend ActiveSupport::Concern

  included do
    self.table_name = "durable_agent_#{model_name.element.pluralize}"
  end

  def readonly? = true
end
