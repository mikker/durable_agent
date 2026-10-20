# frozen_string_literal: true

# The one application frame: navigation rail, route title and actions in the toolbar, one content gutter.
# Adapted from the Nitro Kit "application-shell" catalog pattern, without workspaces or accounts.
class Components::Shell < Components::Base
  PRODUCT_NAME = "Slopdep"

  # `actions` render in the toolbar's trailing slot: each is a block taking no arguments.
  def initialize(title:, current:, back: nil, actions: nil)
    @title, @current, @back, @actions = title, current, back, actions
  end

  def view_template(&content)
    AppShell(id: "application-shell", layout: :sidebar, data: { ui: "application-shell" }) do |shell|
      shell.navigation { render_navigation }
      shell.topbar { render_toolbar }
      shell.main { div(data: { ui: "application-shell-content" }, &content) }
    end
  end

  private
    def render_navigation
      AppNavigation(id: "application-navigation", label: "Primary navigation") do |navigation|
        navigation.header { strong { PRODUCT_NAME } }
        navigation.body do
          navigation.item("Chats", href: chats_path, icon: :messages_square, current: @current == :chats)
          navigation.item("Settings", href: settings_chatgpt_connection_path, icon: :settings, current: @current == :settings)
        end
      end
    end

    def render_toolbar
      Toolbar(id: "application-toolbar") do |toolbar|
        toolbar.leading do
          Button("Back", href: @back.fetch(:href), icon: :arrow_left, label: @back.fetch(:label), size: :sm) if @back
          h1 { @title }
        end
        toolbar.trailing(&@actions) if @actions
      end
    end
end
