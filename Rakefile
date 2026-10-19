require "bundler/setup"

APP_RAKEFILE = File.expand_path("test/dummy/Rakefile", __dir__)
load "rails/tasks/engine.rake"

require "bundler/gem_tasks"

# The gem ships the bundled sidecar (sidecar/dist/sidecar.js); build it before packaging so it is never stale.
namespace :sidecar do
  desc "Bundle the sidecar into sidecar/dist/sidecar.js"
  task :build do
    sh "npm ci --prefix sidecar"
    sh "npm run build --prefix sidecar"
  end
end
task build: "sidecar:build"

# The suite runs on either database; database.yml picks the adapter from DURABLE_AGENT_DB.
desc "Run the tests on SQLite"
task :test do
  sh({ "DURABLE_AGENT_DB" => "sqlite" }, "bin/rails test")
end

namespace :test do
  desc "Run the tests on Postgres (durable_agent_test)"
  task :postgres do
    sh({ "DURABLE_AGENT_DB" => "postgres", "RAILS_ENV" => "test" }, "bin/rails db:create")
    sh({ "DURABLE_AGENT_DB" => "postgres" }, "bin/rails test")
  end

  desc "Run the tests on SQLite, then on Postgres"
  task all: [ :test, :postgres ]
end

task default: :test
