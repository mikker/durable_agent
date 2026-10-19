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

  test "unknown providers are rejected" do
    assert_raises(ArgumentError) { DurableAgent::Connection.new("acme") }
  end
end
