require "rails/generators"
require "rails/generators/active_record"

module DurableAgent
  module Generators
    class InstallGenerator < Rails::Generators::Base
      include Rails::Generators::Migration

      source_root File.expand_path("templates", __dir__)

      SIDECAR = "sidecar: bin/rails durable_agent:sidecar"
      # foreman gives the first process PORT=5000; the sidecar reaches Rails at rails_url, port 3000 by default.
      WEB = "web: bin/rails server -p 3000"

      def self.next_migration_number(dirname)
        ActiveRecord::Generators::Base.next_migration_number(dirname)
      end

      def copy_migration
        migration_template "create_durable_agent_tables.rb.tt", "db/migrate/create_durable_agent_tables.rb"
      end

      def create_initializer
        template "durable_agent.rb.tt", "config/initializers/durable_agent.rb"
      end

      def mount_engine
        routes = File.join(destination_root, "config/routes.rb")
        route %(mount DurableAgent::Engine => "/durable_agent") unless File.read(routes).include?("DurableAgent::Engine")
      end

      def add_sidecar_process
        procfile = File.join(destination_root, "Procfile.dev")

        if !File.exist?(procfile)
          create_file "Procfile.dev", "#{WEB}\n#{SIDECAR}\n"
        else
          append_to_file "Procfile.dev", "#{SIDECAR}\n", force: true unless File.read(procfile).include?(SIDECAR)
          warn_about_web_port File.read(procfile)
        end
      end

      def show_next_steps
        say <<~TEXT

          durable_agent is installed. Next:

            bin/rails db:migrate
            bin/dev            # runs web and sidecar from Procfile.dev (needs foreman or overmind)

          Development and test derive the sidecar token from secret_key_base. In production set one:

            bin/rails credentials:edit     # durable_agent:
                                           #   token: #{SecureRandom.hex(32)}

          or export DURABLE_AGENT_TOKEN for both the web and the sidecar processes. If production uses
          force_ssl or config.hosts, see the note at the end of config/initializers/durable_agent.rb.
        TEXT
      end

      private
        def warn_about_web_port(procfile)
          web = procfile[/^web:.*$/]
          if web && web !~ /\s(-p|--port)[\s=]?\d+/
            say <<~TEXT, :yellow

              Procfile.dev's web process sets no port: foreman runs it on PORT=5000, but the sidecar calls this app at
              config.rails_url, http://127.0.0.1:3000 by default. Change the line to `#{WEB}`,
              or set DURABLE_AGENT_RAILS_URL=http://127.0.0.1:5000.
            TEXT
          end
        end
    end
  end
end
