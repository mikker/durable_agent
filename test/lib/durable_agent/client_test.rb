require "test_helper"

class DurableAgent::ClientTest < ActiveSupport::TestCase
  test "requests carry the bearer token and JSON bodies" do
    FakeSidecar.serve("POST /conversations" => [ 201, { id: 7 } ]) do |sidecar|
      response = client(sidecar).create_conversation(model: "openai/gpt-6.1-sol", instructions: "Be brief")

      assert_equal({ "id" => 7 }, response)
      request = sidecar.requests.sole
      assert_equal "Bearer secret", request[:headers]["authorization"]
      assert_equal({ "model" => { "provider" => "openai", "modelId" => "gpt-6.1-sol" }, "instructions" => "Be brief" }, request[:body])
    end
  end

  test "submit sends the request id as a string and drops an unset when_busy" do
    FakeSidecar.serve("POST /conversations/7/submissions" => [ 202, { id: 3, status: "queued" } ]) do |sidecar|
      assert_equal({ "id" => 3, "status" => "queued" }, client(sidecar).submit(7, "Hi", request_id: 42))
      assert_equal({ "content" => "Hi", "request_id" => "42" }, sidecar.requests.sole[:body])
    end
  end

  test "a busy conversation raises Busy" do
    FakeSidecar.serve("POST /conversations/7/submissions" => [ 409, { error: "conversation_busy" } ]) do |sidecar|
      error = assert_raises(DurableAgent::Busy) { client(sidecar).submit(7, "Hi", request_id: "a", when_busy: "reject") }
      assert_equal 409, error.status
      assert_equal "conversation_busy", error.body["error"]
      assert_equal "reject", sidecar.requests.sole[:body]["when_busy"]
    end
  end

  test "an unknown model raises UnknownModel with suggestions" do
    FakeSidecar.serve("POST /conversations" => [ 422, { error: "unknown model", suggestions: [ "openai/gpt-6.1" ] } ]) do |sidecar|
      error = assert_raises(DurableAgent::UnknownModel) { client(sidecar).create_conversation(model: "openai/gpt-nope") }
      assert_equal [ "openai/gpt-6.1" ], error.suggestions
      assert_match "unknown model", error.message
    end
  end

  test "other failures raise Error with status and body" do
    FakeSidecar.serve({}) do |sidecar|
      error = assert_raises(DurableAgent::Error) { client(sidecar).abort(99) }
      assert_equal 404, error.status
      assert_equal({ "error" => "not found" }, error.body)
    end
  end

  test "an unreachable sidecar raises Unavailable" do
    port = TCPServer.new("127.0.0.1", 0).then { |server| server.addr[1].tap { server.close } }
    error = assert_raises(DurableAgent::Unavailable) { DurableAgent::Client.new(url: "http://127.0.0.1:#{port}", token: "x").health }
    assert_kind_of DurableAgent::Error, error
    assert_match "unreachable", error.message
  end

  test "a sidecar that hangs up mid-request raises Unavailable" do
    FakeSidecar.serve("POST /conversations/7/abort" => [ :hang_up ], "GET /health" => [ :hang_up ]) do |sidecar|
      assert_raises(DurableAgent::Unavailable, match: "unreachable") { client(sidecar).abort(7) }
      assert_raises(DurableAgent::Unavailable) { client(sidecar).health }
    end
  end

  test "a sidecar that is still starting is Unavailable" do
    FakeSidecar.serve("POST /conversations/7/submissions" => [ 503, { error: "starting" } ], "POST /conversations/7/abort" => [ 503, { error: "other" } ]) do |sidecar|
      error = assert_raises(DurableAgent::Unavailable) { client(sidecar).submit(7, "Hi", request_id: 1) }
      assert_equal "sidecar is starting", error.message
      assert_equal 503, error.status

      error = assert_raises(DurableAgent::Error) { client(sidecar).abort(7) }
      assert_not_kind_of DurableAgent::Unavailable, error
    end
  end

  test "end of file, I/O errors and broken pipes are Unavailable" do
    assert_empty [ EOFError, IOError, Errno::EPIPE ] - DurableAgent::Client::UNREACHABLE
  end

  test "auth, login and tool routes" do
    routes = {
      "GET /auth" => [ 200, { openai: { type: "oauth" }, anthropic: nil } ],
      "POST /auth/openai/logins" => [ 201, { id: "l1", status: "awaiting_browser" } ],
      "GET /auth/openai/logins/l1" => [ 200, { id: "l1", status: "exchanging" } ],
      "POST /auth/openai/logins/l1/callback" => [ 200, { id: "l1", status: "done" } ],
      "DELETE /auth/openai/logins/l1" => [ 200, { id: "l1", status: "failed" } ],
      "DELETE /auth/openai" => [ 200, { ok: true } ],
      "POST /tools/reload" => [ 200, { tools: [ "lookup_invoice" ] } ],
      "GET /health" => [ 200, { ok: true, schemaVersion: 1 } ]
    }

    FakeSidecar.serve(routes) do |sidecar|
      client = client(sidecar)
      assert_equal({ "openai" => { "type" => "oauth" }, "anthropic" => nil }, client.auth)
      assert_equal "awaiting_browser", client.start_login("openai")["status"]
      assert_equal "exchanging", client.login("openai", "l1")["status"]
      assert_equal "done", client.complete_login("openai", "l1", "http://localhost:1455/cb?code=c")["status"]
      assert_equal "failed", client.cancel_login("openai", "l1")["status"]
      assert_equal({ "ok" => true }, client.logout("openai"))
      assert_equal [ "lookup_invoice" ], client.reload_tools["tools"]
      assert_equal 1, client.health["schemaVersion"]

      assert_equal({ "url" => "http://localhost:1455/cb?code=c" }, sidecar.requests[3][:body])
    end
  end

  test "account routes carry the account" do
    routes = {
      "POST /conversations" => [ 201, { id: 8 } ],
      "GET /auth?account=u42" => [ 200, { openai: { type: "api_key", source: "stored credential" }, anthropic: nil } ],
      "PUT /auth/openai/api_key?account=u42" => [ 200, { type: "api_key", source: "stored credential" } ],
      "PUT /auth/openai/api_key" => [ 200, { type: "api_key", source: "stored credential" } ],
      "POST /auth/openai/logins?account=u42" => [ 201, { id: "l2", provider: "openai@u42", status: "awaiting_browser" } ],
      "DELETE /auth/openai?account=u42" => [ 200, { ok: true } ]
    }

    FakeSidecar.serve(routes) do |sidecar|
      client = client(sidecar)
      assert_equal({ "id" => 8 }, client.create_conversation(model: "openai/gpt-6.1-sol", account: "u42"))
      assert_equal "api_key", client.auth(account: "u42")["openai"]["type"]
      assert_equal "stored credential", client.set_api_key("openai", "sk-1", account: "u42")["source"]
      assert_equal "api_key", client.set_api_key("openai", "sk-2")["type"]
      assert_equal "openai@u42", client.start_login("openai", account: "u42")["provider"]
      assert_equal({ "ok" => true }, client.logout("openai", account: "u42"))

      create, _, scoped_key, app_key = sidecar.requests
      assert_equal({ "model" => { "provider" => "openai", "modelId" => "gpt-6.1-sol" }, "account" => "u42" }, create[:body])
      assert_equal({ "key" => "sk-1" }, scoped_key[:body])
      assert_equal [ "PUT", { "key" => "sk-2" } ], app_key.values_at(:method, :body)
    end
  end

  test "an invalid account is an ArgumentError" do
    FakeSidecar.serve("GET /auth?account=u%4042" => [ 422, { error: "invalid_account" } ],
      "POST /conversations" => [ 422, { error: "invalid_account" } ]) do |sidecar|
      assert_raises(ArgumentError, match: "invalid account") { client(sidecar).auth(account: "u@42") }
      assert_raises(ArgumentError, match: "invalid account") { client(sidecar).create_conversation(account: "u@42") }
    end
  end

  private
    def client(sidecar) = DurableAgent::Client.new(url: sidecar.url, token: "secret")
end
