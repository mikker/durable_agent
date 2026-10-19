# frozen_string_literal: true

# The message form at the bottom of a chat. While the agent runs, Stop sits next to Send; a message sent then is
# queued as a follow-up.
class Components::Chats::Composer < Components::Base
  def initialize(chat:)
    @chat = chat
  end

  def view_template
    form_with(scope: :message, url: chat_messages_path(@chat), builder: NitroKit::FormBuilder, id: dom_id(@chat, :composer),
      data: { controller: "composer", action: "turbo:submit-end->composer#reset" }) do |form|
      form.group do
        form.field(:content, as: :textarea, rows: 3, label: "Message", placeholder: "Send a message…", required: true,
          control_html: { autofocus: true })
        Flex(dir: :row, gap: 2, justify: :end) do
          Button("Stop", type: :submit, form: dom_id(@chat, :abort), icon: :square) if @chat.busy?
          form.submit("Send", data: { turbo_submits_with: "Sending…" })
        end
      end
    end
    form_with(url: chat_abort_path(@chat), method: :post, id: dom_id(@chat, :abort)) { } if @chat.busy?
  end
end
