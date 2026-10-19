module DurableAgent
  class ToolsController < ApplicationController
    def index
      render json: DurableAgent.config.tools.map(&:to_definition)
    end

    def create
      if tool = DurableAgent.config.tool(params[:name])
        Current.set(conversation_id: body["conversation_id"], call_id: body["call_id"]) do
          render json: { result: tool.run(body["arguments"]) }
        end
      else
        render json: { error: "unknown tool #{params[:name]}" }, status: :not_found
      end
    rescue StandardError => error
      render json: { error: error.message }, status: :unprocessable_content
    end

    private
      # The raw JSON, not params: arguments are the model's object exactly as it produced it.
      def body
        @body ||= JSON.parse(request.raw_post.presence || "{}")
      end
  end
end
