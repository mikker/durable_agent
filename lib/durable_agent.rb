require "durable_agent/version"
require "durable_agent/engine"
require "durable_agent/configuration"
require "durable_agent/client"
require "durable_agent/current"
require "durable_agent/message_text"
require "durable_agent/indexed_string"
require "durable_agent/tool"
require "durable_agent/sidecar"

module DurableAgent
  class << self
    def configure
      yield config
    end

    def config
      @config ||= Configuration.new
    end

    def client
      @client ||= Client.new
    end

    # Creates a conversation on the sidecar and returns its row, which the sidecar commits before it answers.
    # Without a model the sidecar uses its default, which `durable_agent:sidecar` sets from config.model.
    #
    # The sidecar commits in its own transaction, so this cannot join the caller's: when the app's own record
    # fails to save afterwards, the conversation stays behind, unreferenced.
    def start(model: nil, instructions: nil)
      response = client.create_conversation(model: model, instructions: instructions)
      changed_by_sidecar
      conversation(response.fetch("id"))
    end

    def conversation(id)
      Conversation.find(id)
    end

    # Every provider the sidecar knows, signed in or not, with how: {"openai" => {"type" => "oauth", "source" =>
    # "OAuth"}, "anthropic" => {"type" => "api_key", "source" => "ANTHROPIC_API_KEY"}, "google" => nil, ...}.
    # Includes "faux" when the sidecar's model is faux/faux-1.
    def auth
      client.auth
    end

    # The sidecar just committed rows this thread may already have read: drop the query cache so the next read in
    # the same request sees them.
    def changed_by_sidecar
      DurableAgent::ApplicationRecord.connection_pool.clear_query_cache
    end
  end
end
