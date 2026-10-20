Rails.application.routes.draw do
  mount DurableAgent::Engine => "/durable_agent"

  root "chats#index"

  resources :chats, only: %i[ index show create ] do
    scope module: :chats do
      resources :messages, only: :create
      resource :abort, only: :create
    end
  end

  namespace :settings do
    resource :chatgpt_connection, only: %i[ show create update destroy ]
  end

  get "up" => "rails/health#show", as: :rails_health_check
end
