require "durable_agent/version"
require "durable_agent/engine"
require "durable_agent/configuration"
require "durable_agent/client"
require "durable_agent/current"
require "durable_agent/message_text"
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
    def start(model: nil, instructions: nil)
      response = client.create_conversation(model: model, instructions: instructions)
      conversation(response.fetch("id"))
    end

    def conversation(id)
      Conversation.find(id)
    end

    # Which providers the sidecar holds credentials for: {"openai" => {"type" => "oauth"}, "anthropic" => nil}.
    def auth
      client.auth
    end
  end
end
