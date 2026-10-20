require "bundler/setup"

APP_RAKEFILE = File.expand_path("test/dummy/Rakefile", __dir__)
load "rails/tasks/engine.rake"

require "bundler/gem_tasks"

# The gem ships the bundled sidecar (sidecar/dist/sidecar.js), which is not checked in. `rake build` (and
# `rake release`, which runs it) bundles it first so it is never missing or stale; the gemspec refuses a bare
# `gem build` without it.
namespace :sidecar do
  desc "Bundle the sidecar into sidecar/dist/sidecar.js"
  task :build do
    sh "npm ci --prefix sidecar"
    sh "npm run build --prefix sidecar"
    abort "sidecar/dist/sidecar.js was not built" unless File.exist?(File.expand_path("sidecar/dist/sidecar.js", __dir__))
  end
end
task build: "sidecar:build"

# The dummy app's pages need its Tailwind build (gitignored), so the test tasks build it first.
namespace :dummy do
  desc "Build test/dummy's CSS"
  task :css do
    sh "cd test/dummy && bin/rails tailwindcss:build"
  end
end

# The suite runs on either database; database.yml picks the adapter from DURABLE_AGENT_DB.
desc "Run the tests on SQLite"
task test: "dummy:css" do
  sh({ "DURABLE_AGENT_DB" => "sqlite" }, "bin/rails test")
end

namespace :test do
  desc "Run the tests on Postgres (durable_agent_test)"
  task postgres: "dummy:css" do
    sh({ "DURABLE_AGENT_DB" => "postgres", "RAILS_ENV" => "test" }, "bin/rails db:create")
    sh({ "DURABLE_AGENT_DB" => "postgres" }, "bin/rails test")
  end

  desc "Run the tests on SQLite, then on Postgres"
  task all: [ :test, :postgres ]
end

task default: :test
