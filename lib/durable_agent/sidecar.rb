require "erb"

module DurableAgent
  # Starts the bundled sidecar with every setting derived from the Rails app, so the two halves agree.
  module Sidecar
    extend self

    PASS_THROUGH = %w[ OPENAI_API_KEY ANTHROPIC_API_KEY ].freeze

    def env
      config = DurableAgent.config

      {
        "DATABASE_URL" => database_url,
        "DURABLE_AGENT_TOKEN" => config.token,
        "DURABLE_AGENT_HOST" => config.host.to_s,
        "DURABLE_AGENT_PORT" => config.port.to_s,
        "DURABLE_AGENT_RAILS_URL" => config.rails_url.to_s,
        "DURABLE_AGENT_MODEL" => config.model.to_s,
        "DURABLE_AGENT_WORKSPACE_ROOT" => config.workspace_root.to_s,
        "DURABLE_AGENT_NAME" => config.agent_name.to_s
      }.merge(ENV.slice(*PASS_THROUGH))
    end

    # The one place to swap in a compiled binary later. Falls back to the TypeScript source when no bundle was
    # built, which Node runs directly with type stripping.
    def command
      bundle = root.join("dist/sidecar.js")
      [ "node", (bundle.exist? ? bundle : root.join("src/main.ts")).to_s ]
    end

    def exec
      FileUtils.mkdir_p(DurableAgent.config.workspace_root)
      Kernel.exec(env, *command)
    end

    def root
      DurableAgent::Engine.root.join("sidecar")
    end

    # The app's primary database, which the sidecar opens too: pi-durable's tables live there.
    def database_url(db_config = ActiveRecord::Base.connection_db_config)
      return node_sslmode_in(db_config.url) if db_config.respond_to?(:url) && db_config.url.present?

      case db_config.adapter
      when "sqlite3" then sqlite_url(db_config.configuration_hash)
      when "postgresql" then postgres_url(db_config.configuration_hash)
      else raise ArgumentError, "durable_agent needs a postgresql or sqlite3 database, not #{db_config.adapter}"
      end
    end

    # libpq's sslmode=require encrypts without verifying the server's certificate; node-postgres reads `require`
    # as verify-full and would refuse the self-signed certificates many hosted databases use. `no-verify` is
    # node-postgres' name for libpq's `require`. verify-ca and verify-full pass through and verify.
    NODE_SSLMODES = { "require" => "no-verify" }.freeze

    private
      def sqlite_url(config)
        "sqlite://#{File.expand_path(config[:database].to_s, Rails.root)}"
      end

      def postgres_url(config)
        userinfo = [ config[:username], config[:password] ].compact.map { |part| ERB::Util.url_encode(part.to_s) }.join(":")
        host = config[:host].presence || "localhost"
        query = {}

        # A socket directory cannot sit in the authority part of the URL; libpq and node-postgres take it as ?host=.
        if host.start_with?("/")
          query[:host] = host
          host = ""
        end
        query[:sslmode] = NODE_SSLMODES.fetch(config[:sslmode].to_s, config[:sslmode].to_s) if config[:sslmode].present?
        %i[ sslrootcert sslcert sslkey ].each do |key|
          query[key] = File.expand_path(config[key].to_s, Rails.root) if config[key].present?
        end
        query[:options] = "-c search_path=#{search_path(config[:schema_search_path])}" if config[:schema_search_path].present?

        authority = [ userinfo.presence, host ].compact.join("@")
        authority += ":#{config[:port]}" if config[:port].present?
        url = "postgres://#{authority}/#{ERB::Util.url_encode(config[:database].to_s)}"
        query.any? ? "#{url}?#{query.map { |key, value| "#{key}=#{ERB::Util.url_encode(value)}" }.join("&")}" : url
      end

      # A startup option is split on spaces, so "public, shared" must lose its spaces (and any left be escaped).
      def search_path(value)
        value.to_s.split(",").map(&:strip).join(",").gsub(" ", "\\ ")
      end

      def node_sslmode_in(url)
        if url.start_with?("postgres:", "postgresql:")
          url.sub(/([?&]sslmode=)([^&#]*)/) { "#{$1}#{NODE_SSLMODES.fetch($2, $2)}" }
        else
          url
        end
      end
  end
end
