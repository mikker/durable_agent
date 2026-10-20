module DurableAgent
  class Configuration
    class MissingToken < StandardError; end

    attr_writer :model, :tools, :url, :rails_url, :token, :host, :port, :workspace_root, :agent_name,
      :parent_record_class, :on_change, :on_report, :on_auth

    # Defaults come from the same DURABLE_AGENT_* variables the sidecar reads, so `DURABLE_AGENT_PORT=4020 bin/dev`
    # moves both halves at once.
    def model = @model || env("MODEL", "openai/gpt-6.1-sol")
    def host = @host || env("HOST", "127.0.0.1")
    def port = @port || env("PORT", 4010).to_i
    def url = @url || "http://#{host}:#{port}"
    def rails_url = @rails_url || env("RAILS_URL", "http://127.0.0.1:3000")
    def workspace_root = @workspace_root || env("WORKSPACE_ROOT", Rails.root.join("storage/durable_agent").to_s)
    def agent_name = @agent_name || env("NAME", Rails.application.class.module_parent_name)

    # The class DurableAgent::ApplicationRecord inherits from. An app whose ApplicationRecord uses connects_to sets
    # it to "ApplicationRecord", so the harness models follow its roles and shards. Read when the models load, so
    # set it in an initializer.
    def parent_record_class = @parent_record_class || "ActiveRecord::Base"

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

    # A report without a conversation (a failed session, most reports on pi-durable 1.3.0) refreshes the pages
    # subscribed with `turbo_stream_from "durable_agent:reports"`.
    def on_report
      @on_report || ->(report) { Turbo::StreamsChannel.broadcast_refresh_to(report.conversation || "durable_agent:reports") }
    end

    # Called with the provider ids when a sign-in completes or a provider signs out, scoped for accounts
    # ("openai", "openai@u42"). The default refreshes the pages subscribed with `turbo_stream_from
    # DurableAgent.auth_stream`, such as a settings page, and with `turbo_stream_from
    # DurableAgent.auth_stream(account)` for each account named.
    def on_auth
      @on_auth || ->(providers) do
        accounts = providers.filter_map { |provider| DurableAgent::Account.parse(provider).second }.uniq
        [ nil, *accounts ].each { |account| Turbo::StreamsChannel.broadcast_refresh_to(DurableAgent.auth_stream(account)) }
      end
    end

    private
      def env(name, default)
        ENV["DURABLE_AGENT_#{name}"].presence || default
      end

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
