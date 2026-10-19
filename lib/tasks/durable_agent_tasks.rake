namespace :durable_agent do
  desc "Run the durable_agent sidecar with settings derived from this app"
  task sidecar: :environment do
    DurableAgent::Sidecar.exec
  end
end
