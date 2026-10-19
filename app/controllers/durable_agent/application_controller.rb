module DurableAgent
  # The engine renders no views: its only endpoints are the ones the sidecar calls.
  class ApplicationController < ActionController::API
    before_action :authenticate_sidecar

    private
      # `Authorization: Bearer <token>`, exactly: a bare token, another scheme or extra whitespace is refused.
      def authenticate_sidecar
        scheme, given = request.authorization.to_s.split(/ /, 2)
        unless scheme == "Bearer" && ActiveSupport::SecurityUtils.secure_compare(given.to_s, DurableAgent.config.token)
          render json: { error: "unauthorized" }, status: :unauthorized
        end
      end
  end
end
