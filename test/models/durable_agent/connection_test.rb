require "test_helper"

class DurableAgent::ConnectionTest < ActiveSupport::TestCase
  test "status comes from the sidecar" do
    stub_sidecar(auth: CONNECTED)

    openai, anthropic = DurableAgent::Connection.all
    assert openai.connected?
    assert openai.subscription?
    assert_equal "ChatGPT", openai.name
    assert_not anthropic.connected?
    assert_not anthropic.unreachable?
    assert_equal 1, sidecar_calls(:auth).size
  end

  test "an unreachable sidecar reads as not connected, with the error" do
    stub_sidecar(auth: DurableAgent::Unavailable.new(nil, nil, "sidecar unreachable"))

    connection = DurableAgent::Connection.new("openai")
    assert_not connection.connected?
    assert connection.unreachable?
    assert_equal "sidecar unreachable", connection.error

    assert DurableAgent::Connection.all.all?(&:unreachable?)
  end

  test "login calls are scoped to the provider" do
    stub_sidecar(start_login: { "id" => "l1", "status" => "awaiting_browser" }, complete_login: { "status" => "done" },
      cancel_login: { "status" => "failed" }, login: { "status" => "exchanging" }, logout: { "ok" => true })

    connection = DurableAgent::Connection.new(:anthropic)
    assert_equal "awaiting_browser", connection.start_login["status"]
    connection.login("l1")
    connection.complete_login("l1", "http://localhost/callback?code=x")
    connection.cancel_login("l1")
    connection.disconnect

    assert_equal [ [ :start_login, [ "anthropic" ] ], [ :login, [ "anthropic", "l1" ] ],
      [ :complete_login, [ "anthropic", "l1", "http://localhost/callback?code=x" ] ], [ :cancel_login, [ "anthropic", "l1" ] ],
      [ :logout, [ "anthropic" ] ] ], sidecar_calls.map { it.first(2) }
  end

  test "an account's connections read that account's status" do
    stub_sidecar(auth: ->(account: nil) { account == "u42" ? { "openai" => { "type" => "api_key", "source" => "stored credential" } } : CONNECTED })

    openai, anthropic = DurableAgent::Connection.all(account: "u42")
    assert_equal "u42", openai.account
    assert_equal "openai@u42", openai.scoped_provider
    assert openai.connected?
    assert openai.api_key?
    assert_not openai.subscription?
    assert_equal "stored credential", openai.source
    assert_not anthropic.connected?
    assert_equal [ [ :auth, [], { account: "u42" } ] ], sidecar_calls

    assert DurableAgent::Connection.new("openai").subscription?
    assert_equal "OAuth", DurableAgent::Connection.new("openai").source
    assert_equal [ :auth, [], {} ], sidecar_calls.last
  end

  test "the account is normalized" do
    assert_equal "42", DurableAgent::Connection.new("openai", account: 42).account
    assert_nil DurableAgent::Connection.new("openai", account: "").account
    assert_equal "openai", DurableAgent::Connection.new("openai").scoped_provider
    assert_raises(ArgumentError) { DurableAgent::Connection.new("openai", account: "u@42") }
  end

  test "set_api_key stores the key for the account and takes the new status" do
    stored = { "type" => "api_key", "source" => "stored credential" }
    stub_sidecar(set_api_key: stored)

    connection = DurableAgent::Connection.new("openai", account: "u42", status: nil)
    assert_equal stored, connection.set_api_key("sk-1")
    assert connection.api_key?
    assert_equal [ [ :set_api_key, [ "openai", "sk-1" ], { account: "u42" } ] ], sidecar_calls

    DurableAgent::Connection.new("openai").set_api_key("sk-2")
    assert_equal [ :set_api_key, [ "openai", "sk-2" ], {} ], sidecar_calls.last

    assert_raises(ArgumentError) { connection.set_api_key(" ") }
    assert_equal 2, sidecar_calls.size
  end

  test "an account's login and sign-out carry the account" do
    stub_sidecar(start_login: { "id" => "l1", "provider" => "openai@u42" }, login: {}, complete_login: {}, cancel_login: {},
      logout: { "ok" => true })

    connection = DurableAgent::Connection.new("openai", account: "u42")
    connection.start_login
    connection.login("l1")
    connection.complete_login("l1", "http://localhost/callback?code=x")
    connection.cancel_login("l1")
    connection.disconnect

    assert_equal [ [ :start_login, [ "openai" ], { account: "u42" } ], [ :login, [ "openai", "l1" ], {} ],
      [ :complete_login, [ "openai", "l1", "http://localhost/callback?code=x" ], {} ], [ :cancel_login, [ "openai", "l1" ], {} ],
      [ :logout, [ "openai" ], { account: "u42" } ] ], sidecar_calls
  end

  test "stream_name is the account's auth stream" do
    assert_equal "durable_agent:auth", DurableAgent::Connection.new("openai").stream_name
    assert_equal "durable_agent:auth:u42", DurableAgent::Connection.new("openai", account: "u42").stream_name
  end

  test "unknown providers are rejected" do
    assert_raises(ArgumentError) { DurableAgent::Connection.new("acme") }
  end
end
