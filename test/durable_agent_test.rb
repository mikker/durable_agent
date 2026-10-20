require "test_helper"

class DurableAgentTest < ActiveSupport::TestCase
  test "it has a version number" do
    assert DurableAgent::VERSION
  end

  test "auth reads the app's providers, or an account's" do
    stub_sidecar(auth: CONNECTED)

    assert_equal CONNECTED, DurableAgent.auth
    assert_equal CONNECTED, DurableAgent.auth(account: :u42)
    assert_equal [ [ :auth, [], {} ], [ :auth, [], { account: "u42" } ] ], sidecar_calls
    assert_raises(ArgumentError) { DurableAgent.auth(account: "u 42") }
  end

  test "auth_stream names the app's stream or the account's" do
    assert_equal "durable_agent:auth", DurableAgent.auth_stream
    assert_equal "durable_agent:auth", DurableAgent.auth_stream("")
    assert_equal "durable_agent:auth:u42", DurableAgent.auth_stream("u42")
    assert_equal "durable_agent:auth:42", DurableAgent.auth_stream(42)
  end
end
