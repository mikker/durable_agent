require "turbo-rails"

module DurableAgent
  class Engine < ::Rails::Engine
    isolate_namespace DurableAgent

    # Production must share a real secret with the sidecar. Asset builds run without one, so they are let through.
    config.after_initialize do
      DurableAgent.config.token if Rails.env.production? && ENV["SECRET_KEY_BASE_DUMMY"].blank?
    end
  end
end
