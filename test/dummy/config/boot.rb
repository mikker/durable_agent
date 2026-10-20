# The dummy app runs on the gem's Gemfile.
ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../../../Gemfile", __dir__)

require "bundler/setup" # Set up gems listed in the Gemfile.
