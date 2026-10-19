require_relative "lib/durable_agent/version"

Gem::Specification.new do |spec|
  spec.name        = "durable_agent"
  spec.version     = DurableAgent::VERSION
  spec.authors     = [ "Mikkel Malmberg" ]
  spec.email       = [ "mikkel@brnbw.com" ]
  spec.homepage    = "https://github.com/mikker/durable_agent"
  spec.summary     = "A durable AI agent runtime for Rails: pi-durable as a bundled sidecar, mirrored into Postgres."
  spec.description = "Crash-safe, resumable agent conversations for Rails. Ships the pi-durable runtime as a sidecar " \
                     "process inside the gem, mirrors every committed frame into your Postgres, broadcasts over Turbo, " \
                     "and lets you write tools in Ruby."
  spec.license     = "MIT"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["changelog_uri"] = "#{spec.homepage}/blob/main/CHANGELOG.md"

  spec.required_ruby_version = ">= 3.3"

  spec.files = Dir.chdir(File.expand_path(__dir__)) do
    Dir["{app,config,db,lib}/**/*", "sidecar/dist/**/*", "sidecar/sql/**/*", "sidecar/package.json",
        "MIT-LICENSE", "Rakefile", "README.md", "DESIGN.md"]
  end

  spec.add_dependency "rails", ">= 8.0"
  spec.add_dependency "turbo-rails", ">= 2.0"
  spec.add_dependency "pg", ">= 1.5"
end
