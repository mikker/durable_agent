class ApplicationController < ActionController::Base
  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  # Changes to the importmap will invalidate the etag for HTML responses
  stale_when_importmap_changes

  # Commands go to the sidecar over HTTP; reads never do. Tell the user instead of failing the request.
  rescue_from DurableAgent::Error do |error|
    message = error.is_a?(DurableAgent::Unavailable) ? "The agent sidecar is not running." : "The agent sidecar refused: #{error.message}"
    redirect_back_or_to root_path, status: :see_other, alert: message
  end
end
