DurableAgent::Engine.routes.draw do
  get "tools", to: "tools#index"
  post "tools/:name", to: "tools#create", as: :tool
  post "events", to: "events#create"
end
