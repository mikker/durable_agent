require_relative "lib/durable_agent/version"

# The gem ships the bundled sidecar, which is not checked in. `rake build` bundles it, then packages; a bare
# `gem build` would package whatever sidecar/dist holds, so it refuses when there is no bundle.
if defined?(Gem::Commands::BuildCommand) && !File.exist?(File.expand_path("sidecar/dist/sidecar.js", __dir__))
  abort "sidecar/dist/sidecar.js is missing: package the gem with `bundle exec rake build`, which bundles the sidecar first"
end

Gem::Specification.new do |spec|
  spec.name        = "durable_agent"
  spec.version     = DurableAgent::VERSION
  spec.authors     = [ "Mikkel Malmberg" ]
  spec.email       = [ "mikkel@brnbw.com" ]
  spec.homepage    = "https://github.com/mikker/durable_agent"
  spec.summary     = "A durable AI agent runtime for Rails: pi-durable as a bundled sidecar, in your own database."
  spec.description = "Crash-safe, resumable agent conversations for Rails. Ships the pi-durable runtime as a sidecar " \
                     "process inside the gem that keeps its state in your app's database, Postgres or SQLite, which " \
                     "Rails reads with Active Record. Broadcasts over Turbo, and lets you write tools in Ruby."
  spec.license     = "MIT"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["changelog_uri"] = "#{spec.homepage}/blob/main/CHANGELOG.md"

  spec.required_ruby_version = ">= 3.3"

  spec.files = Dir.chdir(File.expand_path(__dir__)) do
    Dir["{app,config,db,lib}/**/*", "sidecar/dist/**/*", "sidecar/sql/**/*", "sidecar/package.json",
        "MIT-LICENSE", "Rakefile", "README.md", "DESIGN.md", "CHANGELOG.md"]
  end

  spec.add_dependency "rails", ">= 8.0"
  spec.add_dependency "turbo-rails", ">= 2.0"
  # No database adapter: the app brings pg or sqlite3, as it already does for itself.
end
