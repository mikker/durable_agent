# frozen_string_literal: true

# Sign in with ChatGPT. Three states: connected, signed out, or a login in progress (a link to open and a field
# for the URL the browser ended on).
class Views::Settings::ChatgptConnections::Show < Views::Base
  def initialize(connection:, login:, model: nil)
    @connection, @login, @model = connection, login, model
  end

  def view_template
    content_for(:title, "Settings")
    render Components::Shell.new(title: "Settings", current: :settings) do
      Container(size: :md) do
        Card do |card|
          card.header do
            card.title("ChatGPT")
            card.description("Run the agent on your ChatGPT plan with OpenAI's models.")
          end
          card.body { state }
        end
      end
    end
  end

  private
    def pending? = @login.present? && !@login["status"].in?(%w[ done failed ])

    def state
      if @connection.unreachable? then render Components::ConnectionNotice.new(connection: @connection)
      elsif @connection.connected? then connected
      elsif pending? then pending
      else signed_out
      end
    end

    def connected
      Flex(dir: :col, gap: 4, align: :start) do
        Badge(@connection.subscription? ? "Connected with a ChatGPT subscription" : "Connected with an API key", color: :success)
        p { "The agent runs #{@model}." } if @model
        ButtonTo("Disconnect", href: settings_chatgpt_connection_path, method: :delete, variant: :destructive, size: :sm)
      end
    end

    def signed_out
      Flex(dir: :col, gap: 4, align: :start) do
        if @login&.dig("status") == "failed"
          Alert(variant: :destructive, title: "Sign-in failed", description: @login["error"].to_s)
        end
        p { "Sign in once; the sidecar keeps the credential, encrypted, and refreshes it." }
        ButtonTo("Sign in with ChatGPT", href: settings_chatgpt_connection_path, variant: :primary, icon: :log_in)
      end
    end

    # Refreshes every few seconds: the sidecar's listener on 127.0.0.1:1455 can finish the login without a paste.
    def pending
      div(data: { controller: "poll", poll_interval_value: 3000 }) do
        Flex(dir: :col, gap: 6, align: :stretch) do
          Flex(dir: :col, gap: 2, align: :start) do
            Button("Open ChatGPT sign-in", href: @login["url"], target: "_blank", rel: "noopener", variant: :primary, icon_end: :external_link)
            p { "Approve #{DurableAgent.config.agent_name} in the new browser tab. This page notices when you are done." }
          end

          form_with(url: settings_chatgpt_connection_path(login_id: @login["id"]), method: :patch, builder: NitroKit::FormBuilder) do |form|
            form.group do
              Field(
                as: :url, name: "redirect_url", id: "redirect_url", label: "Redirect URL", required: true,
                placeholder: "http://localhost:1455/auth/callback?code=…",
                description: "If the browser ends on an address that does not load, copy it from the address bar and paste it here."
              )
              Flex(dir: :row, gap: 2, justify: :end) { form.submit("Finish sign-in") }
            end
          end

          Flex(dir: :row, gap: 2, align: :center, wrap: :wrap) do
            Badge(@login["status"].to_s.humanize, size: :sm, color: :info)
            span { @login["messages"].last.to_s } if @login["messages"].present?
          end
        end
      end
    end
end
