namespace :durable_agent do
  desc "Run the durable_agent sidecar with settings derived from this app"
  task sidecar: :environment do
    DurableAgent::Sidecar.exec
  end

  desc "Relay mirror notifications from Postgres to DurableAgent.config.on_mirror / on_report"
  task relay: :environment do
    DurableAgent::Relay.new.run
  end
end
