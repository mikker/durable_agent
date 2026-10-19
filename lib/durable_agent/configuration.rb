module DurableAgent
  class Configuration
    class MissingToken < StandardError; end

    attr_writer :model, :tools, :url, :rails_url, :token, :host, :port, :workspace_root, :agent_name,
      :on_change, :on_report

    def model = @model || "openai/gpt-6.1-sol"
    def host = @host || "127.0.0.1"
    def port = @port || 4010
    def url = @url || "http://#{host}:#{port}"
    def rails_url = @rails_url || "http://127.0.0.1:3000"
    def workspace_root = @workspace_root || Rails.root.join("storage/durable_agent").to_s
    def agent_name = @agent_name || Rails.application.class.module_parent_name

    # Entries may be classes or class names. Names are resolved on every call so they survive code reloading.
    def tools
      Array(@tools).map { |tool| tool.is_a?(String) ? tool.constantize : tool }
    end

    def tool(name)
      tools.find { |tool| tool.tool_name == name.to_s }
    end

    # Both halves read this: Rails to authenticate the sidecar's calls and talk to it, the rake task to start it.
    # Development and test derive one from secret_key_base so nothing needs setting up. A blank token would let
    # an empty Authorization header through, so it is refused rather than compared.
    def token
      @token = default_token if @token.nil?
      raise MissingToken, "DurableAgent.config.token is blank" if @token.blank?
      @token
    end

    # Called from Puma when the sidecar posts a change event for the conversation.
    def on_change
      @on_change || ->(conversation) { Turbo::StreamsChannel.broadcast_refresh_to(conversation) }
    end

    def on_report
      @on_report || ->(report) { Turbo::StreamsChannel.broadcast_refresh_to(report.conversation) if report.conversation }
    end

    private
      def default_token
        Rails.application.credentials.dig(:durable_agent, :token).presence ||
          ENV["DURABLE_AGENT_TOKEN"].presence ||
          derived_token ||
          raise(MissingToken, "Set credentials.durable_agent.token or DURABLE_AGENT_TOKEN, or assign DurableAgent.config.token")
      end

      def derived_token
        if Rails.env.local?
          Rails.application.key_generator.generate_key("durable_agent/token", 32).unpack1("H*")
        end
      end
  end
end
