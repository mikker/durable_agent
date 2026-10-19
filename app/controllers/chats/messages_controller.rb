class Chats::MessagesController < ApplicationController
  def create
    chat = Chat.find(params[:chat_id])
    content = params.expect(message: [ :content ])[:content].to_s.strip
    chat.say(content) if content.present?
    redirect_to chat, status: :see_other
  end
end
