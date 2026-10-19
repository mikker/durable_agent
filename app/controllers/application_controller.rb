class ApplicationController < ActionController::Base
  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  # Changes to the importmap will invalidate the etag for HTML responses
  stale_when_importmap_changes

  # Commands go to the sidecar over HTTP; reads never do. Tell the user instead of failing the request.
  rescue_from DurableAgent::Error do |error|
    redirect_back_or_to root_path, status: :see_other, alert: sidecar_error_message(error)
  end

  private
    # Unavailable is raised both when the sidecar is down and, with status 503, while it boots ("sidecar is starting").
    def sidecar_error_message(error)
      case error
      when DurableAgent::Unavailable
        error.status == 503 ? "The agent sidecar is starting. Try again in a moment." : "The agent sidecar is not running."
      else
        "The agent sidecar refused: #{error.message}"
      end
    end
end
