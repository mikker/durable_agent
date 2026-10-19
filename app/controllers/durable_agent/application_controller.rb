module DurableAgent
  # The engine renders no views: its only endpoints are the ones the sidecar calls.
  class ApplicationController < ActionController::API
    before_action :authenticate_sidecar

    private
      def authenticate_sidecar
        given = request.authorization.to_s.delete_prefix("Bearer ")
        unless ActiveSupport::SecurityUtils.secure_compare(given, DurableAgent.config.token)
          render json: { error: "unauthorized" }, status: :unauthorized
        end
      end
  end
end
