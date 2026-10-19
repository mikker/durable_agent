class ChatsController < ApplicationController
  def index
    render Views::Chats::Index.new(chats: Chat.by_last_activity.includes(:conversation), connection: connection)
  end

  def show
    render Views::Chats::Show.new(chat: Chat.find(params[:id]), connection: connection)
  end

  def create
    redirect_to Chat.start, status: :see_other
  end

  private
    def connection
      DurableAgent::Connection.new("openai")
    end
end
