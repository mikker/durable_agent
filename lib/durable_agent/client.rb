require "net/http"
require "json"

module DurableAgent
  class Error < StandardError
    attr_reader :status, :body

    def initialize(status = nil, body = nil, message = nil)
      @status, @body = status, body
      super(message || "sidecar returned #{status}: #{body.is_a?(Hash) ? body["error"] || body.to_json : body}")
    end
  end

  # 409: the conversation is running and the submission asked to be rejected rather than queued.
  class Busy < Error; end

  # 422 on conversation creation: the model id is not one pi knows.
  class UnknownModel < Error
    def suggestions = body.is_a?(Hash) ? Array(body["suggestions"]) : []
  end

  # The sidecar is not running, did not answer in time, or went away mid-response.
  class Unavailable < Error; end

  # The sidecar's HTTP API v1. Rails sends commands here and reads the results from the harness tables.
  class Client
    UNREACHABLE = [ Errno::ECONNREFUSED, Errno::ECONNRESET, Errno::EHOSTUNREACH, Errno::EPIPE, Net::OpenTimeout, Net::ReadTimeout,
      SocketError, EOFError, IOError ]

    def initialize(url: nil, token: nil)
      @url, @token = url, token
    end

    def url = @url || DurableAgent.config.url
    def token = @token || DurableAgent.config.token

    def health = get("/health")

    # `model` is "provider/modelId" or {provider:, modelId:}. With `account` the conversation runs on that account's
    # credentials: its model's provider becomes "provider@account".
    def create_conversation(model: nil, instructions: nil, account: nil)
      post("/conversations", { model: model_payload(model), instructions: instructions, account: account&.to_s }.compact)
    rescue Error => error
      raise UnknownModel.new(error.status, error.body) if error.status == 422
      raise
    end

    def submit(conversation_id, content, request_id:, when_busy: nil)
      post("/conversations/#{conversation_id}/submissions",
        { content: content, request_id: request_id.to_s, when_busy: when_busy&.to_s }.compact)
    end

    def abort(conversation_id) = post("/conversations/#{conversation_id}/abort")

    # `provider` is the base id ("openai"); `account` scopes it. A login's id names its account, so the calls that
    # take one need none.
    def auth(account: nil) = get(scoped("/auth", account))
    def set_api_key(provider, key, account: nil) = put(scoped("/auth/#{provider}/api_key", account), { key: key })
    def start_login(provider, account: nil) = post(scoped("/auth/#{provider}/logins", account))
    def login(provider, id) = get("/auth/#{provider}/logins/#{id}")
    def complete_login(provider, id, url) = post("/auth/#{provider}/logins/#{id}/callback", { url: url })
    def cancel_login(provider, id) = delete("/auth/#{provider}/logins/#{id}")
    def logout(provider, account: nil) = delete(scoped("/auth/#{provider}", account))

    def reload_tools = post("/tools/reload")

    private
      def get(path) = request(Net::HTTP::Get.new(path))
      def delete(path) = request(Net::HTTP::Delete.new(path))
      def post(path, body = {}) = request(Net::HTTP::Post.new(path), body)
      def put(path, body = {}) = request(Net::HTTP::Put.new(path), body)

      def scoped(path, account)
        account.nil? ? path : "#{path}?#{URI.encode_www_form(account: account)}"
      end

      def request(http_request, body = nil)
        http_request["Authorization"] = "Bearer #{token}"
        http_request["Accept"] = "application/json"
        if body
          http_request["Content-Type"] = "application/json"
          http_request.body = body.to_json
        end

        uri = URI(url)
        response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 5, read_timeout: 15) do |http|
          http.request(http_request)
        end

        body = parse(response.body)
        error = body["error"] if body.is_a?(Hash)
        # Until the harness has resumed (after tools load) the sidecar answers commands with 503 "starting".
        raise Unavailable.new(503, body, "sidecar is starting") if response.code == "503" && error == "starting"
        # Ruby validates accounts before sending them, so this is a programming error rather than a sidecar failure.
        raise ArgumentError, "invalid account" if response.code == "422" && error == "invalid_account"

        case response
        when Net::HTTPSuccess then body || {}
        when Net::HTTPConflict then raise Busy.new(response.code.to_i, body)
        else raise Error.new(response.code.to_i, body)
        end
      rescue *UNREACHABLE => error
        raise Unavailable.new(nil, nil, "sidecar unreachable at #{url}: #{error.message}")
      end

      def parse(body)
        JSON.parse(body) if body.present?
      rescue JSON::ParserError
        body
      end

      def model_payload(model)
        case model
        when nil, Hash then model
        else
          provider, model_id = model.to_s.split("/", 2)
          { provider: provider, modelId: model_id }
        end
      end
  end
end
