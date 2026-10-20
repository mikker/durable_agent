# Provider sign-in as Rails sees it. Pure sidecar calls: the sidecar stores the tokens and keys in
# durable_agent_credentials, encrypted with a key derived from DURABLE_AGENT_TOKEN, and Rails never reads or
# decrypts them.
#
#   connection = DurableAgent::Connection.new("openai")
#   login = connection.start_login       # => {"id" => ..., "status" => "awaiting_browser", "url" => "https://..."}
#   connection.complete_login(login["id"], pasted_url)
#
# With an account the connection is that account's own credential, which the conversations started with
# `DurableAgent.start(account:)` run on:
#
#   DurableAgent::Connection.new("openai", account: user.id).set_api_key(params[:key])
class DurableAgent::Connection
  PROVIDERS = { "openai" => "ChatGPT", "anthropic" => "Claude" }.freeze

  attr_reader :provider, :account, :error

  def self.all(account: nil)
    statuses = DurableAgent.auth(account: account)
    PROVIDERS.keys.map { |provider| new(provider, account: account, status: statuses[provider]) }
  rescue DurableAgent::Error => error
    PROVIDERS.keys.map { |provider| new(provider, account: account, status: nil, error: error.message) }
  end

  def initialize(provider, account: nil, status: :unknown, error: nil)
    @provider = provider.to_s
    raise ArgumentError, "unknown provider #{provider}" unless PROVIDERS.key?(@provider)
    @account = DurableAgent::Account.normalize(account)
    @status, @error = status, error
  end

  def status
    @status = DurableAgent.auth(account: account)[provider] if @status == :unknown
    @status
  rescue DurableAgent::Error => error
    @error = error.message
    @status = nil
  end

  def name = PROVIDERS.fetch(provider)
  def scoped_provider = DurableAgent::Account.scoped(provider, account)
  def stream_name = DurableAgent.auth_stream(account)

  def connected? = status.present?
  def subscription? = status&.dig("type") == "oauth"
  def api_key? = status&.dig("type") == "api_key"
  def source = status&.dig("source")
  def unreachable? = status.nil? && error.present?

  # Stores the key on the sidecar, encrypted, and returns the new status.
  def set_api_key(key)
    raise ArgumentError, "API key is blank" if key.blank?
    @error = nil
    @status = client.set_api_key(provider, key, **scope)
  end

  def start_login = client.start_login(provider, **scope)
  def login(id) = client.login(provider, id)
  def complete_login(id, url) = client.complete_login(provider, id, url)
  def cancel_login(id) = client.cancel_login(provider, id)
  def disconnect = client.logout(provider, **scope)

  private
    def client = DurableAgent.client
    def scope = DurableAgent.account_scope(account)
end
