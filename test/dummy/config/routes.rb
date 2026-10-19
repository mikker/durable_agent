Rails.application.routes.draw do
  mount DurableAgent::Engine => "/durable_agent"
end
