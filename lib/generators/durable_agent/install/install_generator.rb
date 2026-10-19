require "rails/generators"
require "rails/generators/active_record"

module DurableAgent
  module Generators
    class InstallGenerator < Rails::Generators::Base
      include Rails::Generators::Migration

      source_root File.expand_path("templates", __dir__)

      SIDECAR = "sidecar: bin/rails durable_agent:sidecar"

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
          create_file "Procfile.dev", "web: bin/rails server\n#{SIDECAR}\n"
        elsif !File.read(procfile).include?(SIDECAR)
          append_to_file "Procfile.dev", "#{SIDECAR}\n", force: true
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
    end
  end
end
