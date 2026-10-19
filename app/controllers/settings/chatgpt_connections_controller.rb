# Sign in with ChatGPT. The sidecar runs OpenAI's OAuth flow: this page shows the sign-in link, and either the
# sidecar's loopback listener on 127.0.0.1:1455 finishes the login by itself (browser on the sidecar's machine) or
# the user pastes the URL the browser ended on and we hand it back.
class Settings::ChatgptConnectionsController < ApplicationController
  before_action :set_connection

  def show
    login = @connection.login(params[:login_id]) if params[:login_id]
    render Views::Settings::ChatgptConnections::Show.new(connection: @connection, login: login, model: running_model)
  rescue DurableAgent::Error => error
    raise if error.is_a?(DurableAgent::Unavailable)
    redirect_to settings_chatgpt_connection_path, status: :see_other, alert: "That sign-in has expired." # unknown login id
  end

  def create
    login = @connection.start_login
    redirect_to settings_chatgpt_connection_path(login_id: login["id"]), status: :see_other
  end

  def update
    @connection.complete_login(params[:login_id], params.require(:redirect_url))
    redirect_to settings_chatgpt_connection_path(login_id: params[:login_id]), status: :see_other
  end

  def destroy
    @connection.disconnect
    redirect_to settings_chatgpt_connection_path, status: :see_other, notice: "ChatGPT disconnected"
  end

  private
    def set_connection
      @connection = DurableAgent::Connection.new("openai")
    end

    # The model the sidecar actually runs, which DURABLE_AGENT_MODEL in the sidecar's environment can override.
    def running_model
      DurableAgent.client.health["model"]&.values_at("provider", "modelId")&.join("/")
    rescue DurableAgent::Error
      nil
    end
end
