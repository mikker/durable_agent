class Chats::AbortsController < ApplicationController
  def create
    chat = Chat.find(params[:chat_id])
    chat.stop
    redirect_to chat, status: :see_other
  end
end
