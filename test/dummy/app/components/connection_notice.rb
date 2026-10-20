# frozen_string_literal: true

# Says why the agent cannot answer: the sidecar is not running, or no model provider is signed in.
class Components::ConnectionNotice < Components::Base
  def initialize(connection:)
    @connection = connection
  end

  def view_template
    if @connection.unreachable?
      Alert(variant: :warning, title: "Agent sidecar unreachable") do |alert|
        alert.description do
          p { "Start it with bin/dev, or on its own with bin/rails durable_agent:sidecar." }
          p { small { @connection.error.to_s } }
        end
      end
    elsif !@connection.connected?
      Alert(variant: :info) do |alert|
        alert.title("Connect ChatGPT")
        alert.description do
          p { "Messages are accepted, but the agent cannot answer until you sign in." }
          Button("Sign in with ChatGPT", href: settings_chatgpt_connection_path, variant: :primary, size: :sm)
        end
      end
    end
  end
end
