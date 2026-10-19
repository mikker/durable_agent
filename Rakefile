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
