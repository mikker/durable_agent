# Provider sign-in as Rails sees it. Pure sidecar calls: the sidecar stores the tokens in durable_agent_credentials,
# encrypted with a key derived from DURABLE_AGENT_TOKEN, and Rails never reads or decrypts them.
#
#   connection = DurableAgent::Connection.new("openai")
#   login = connection.start_login       # => {"id" => ..., "status" => "awaiting_browser", "url" => "https://..."}
#   connection.complete_login(login["id"], pasted_url)
class DurableAgent::Connection
  PROVIDERS = { "openai" => "ChatGPT", "anthropic" => "Claude" }.freeze

  attr_reader :provider, :error

  def self.all
    statuses = begin
      DurableAgent.auth
    rescue DurableAgent::Error => error
      return PROVIDERS.keys.map { |provider| new(provider, status: nil, error: error.message) }
    end

    PROVIDERS.keys.map { |provider| new(provider, status: statuses[provider]) }
  end

  def initialize(provider, status: :unknown, error: nil)
    @provider = provider.to_s
    raise ArgumentError, "unknown provider #{provider}" unless PROVIDERS.key?(@provider)
    @status, @error = status, error
  end

  def status
    @status = DurableAgent.auth[provider] if @status == :unknown
    @status
  rescue DurableAgent::Error => error
    @error = error.message
    @status = nil
  end

  def name = PROVIDERS.fetch(provider)
  def connected? = status.present?
  def subscription? = status&.dig("type") == "oauth"
  def unreachable? = status.nil? && error.present?

  def start_login = DurableAgent.client.start_login(provider)
  def login(id) = DurableAgent.client.login(provider, id)
  def complete_login(id, url) = DurableAgent.client.complete_login(provider, id, url)
  def cancel_login(id) = DurableAgent.client.cancel_login(provider, id)
  def disconnect = DurableAgent.client.logout(provider)
end
