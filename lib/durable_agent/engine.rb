require "turbo-rails"

module DurableAgent
  class Engine < ::Rails::Engine
    isolate_namespace DurableAgent
  end
end
