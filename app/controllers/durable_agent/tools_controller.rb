module DurableAgent
  # The model sees a tool's error message, so only errors meant for it carry their message: bad arguments, a
  # missing record, and DurableAgent::Tool::Error. Anything else is reported to Rails.error and reaches the model as
  # its class name only, so a message holding SQL, paths or secrets stays in the app.
  class ToolsController < ApplicationController
    MODEL_FACING = [ ArgumentError, ActiveRecord::RecordNotFound, DurableAgent::Tool::Error ]

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
    rescue *MODEL_FACING => error
      render json: { error: error.message }, status: :unprocessable_content
    rescue StandardError => error
      Rails.error.report(error, context: { durable_agent: :tool, tool: params[:name], conversation_id: @body.to_h["conversation_id"] })
      render json: { error: "#{error.class} while running #{params[:name]}" }, status: :unprocessable_content
    end

    private
      # The raw JSON, not params: arguments are the model's object exactly as it produced it.
      def body
        @body ||= JSON.parse(request.raw_post.presence || "{}")
      end
  end
end
