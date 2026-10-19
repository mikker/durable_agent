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
        "DURABLE_AGENT_STORAGE_PATH" => config.storage_path.to_s,
        "DURABLE_AGENT_WORKSPACE_ROOT" => config.workspace_root.to_s,
        "DURABLE_AGENT_NAME" => config.agent_name.to_s,
        "DURABLE_AGENT_MIRROR_DOCS" => Array(config.mirror_docs).join(",")
      }.merge(ENV.slice(*PASS_THROUGH))
    end

    # The one place to swap in a compiled binary later. Falls back to the TypeScript source when no bundle was
    # built, which Node runs directly with type stripping.
    def command
      bundle = root.join("dist/sidecar.js")
      [ "node", (bundle.exist? ? bundle : root.join("src/main.ts")).to_s ]
    end

    def exec
      FileUtils.mkdir_p(File.dirname(DurableAgent.config.storage_path))
      Kernel.exec(env, *command)
    end

    def root
      DurableAgent::Engine.root.join("sidecar")
    end

    def database_url(db_config = ActiveRecord::Base.connection_db_config)
      return db_config.url if db_config.respond_to?(:url) && db_config.url.present?

      config = db_config.configuration_hash
      userinfo = [ config[:username], config[:password] ].compact.map { |part| ERB::Util.url_encode(part.to_s) }.join(":")
      host = config[:host].presence || "localhost"
      query = {}

      # A socket directory cannot sit in the authority part of the URL; libpq and node-postgres take it as ?host=.
      if host.start_with?("/")
        query[:host] = host
        host = ""
      end

      authority = [ userinfo.presence, host ].compact.join("@")
      authority += ":#{config[:port]}" if config[:port].present?
      url = "postgres://#{authority}/#{ERB::Util.url_encode(config[:database].to_s)}"
      query.any? ? "#{url}?#{URI.encode_www_form(query)}" : url
    end
  end
end
