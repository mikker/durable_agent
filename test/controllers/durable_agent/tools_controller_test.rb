require "test_helper"

class DurableAgent::ToolsControllerTest < ActionDispatch::IntegrationTest
  class LookupInvoice < DurableAgent::Tool
    description "Fetch one invoice by number"
    param :number, :string, "Invoice number"
    replay :safe

    def call(number:)
      raise ActiveRecord::RecordNotFound, "no invoice #{number}" unless number == "INV-1"
      { number: number, conversation_id: DurableAgent::Current.conversation_id, call_id: DurableAgent::Current.call_id }
    end
  end

  class Greet < DurableAgent::Tool
    param :name, :string
    def call(name:) = "Hello #{name}"
  end

  class Explode < DurableAgent::Tool
    def call = raise("boom")
  end

  setup do
    @tools = DurableAgent.config.instance_variable_get(:@tools)
    DurableAgent.config.tools = [ LookupInvoice, "DurableAgent::ToolsControllerTest::Greet", Explode ]
  end

  teardown { DurableAgent.config.tools = @tools }

  test "requires the shared token" do
    get "/durable_agent/tools"
    assert_response :unauthorized

    post "/durable_agent/tools/greet", params: { arguments: { name: "x" } }, headers: auth("wrong"), as: :json
    assert_response :unauthorized
    assert_equal "unauthorized", response.parsed_body["error"]
  end

  test "lists tool definitions" do
    get "/durable_agent/tools", headers: auth
    assert_response :ok
    assert_equal %w[ lookup_invoice greet explode ], response.parsed_body.map { it["name"] }
    assert_equal({ "name" => "lookup_invoice", "description" => "Fetch one invoice by number",
      "parameters" => { "type" => "object", "properties" => { "number" => { "type" => "string", "description" => "Invoice number" } },
        "required" => [ "number" ], "additionalProperties" => false }, "replay" => "safe" }, response.parsed_body.first)
  end

  test "runs a tool with the conversation and call ids set" do
    run_tool "lookup_invoice", arguments: { number: "INV-1" }, conversation_id: 7, call_id: "call-1"
    assert_response :ok
    assert_equal({ "result" => { "number" => "INV-1", "conversation_id" => 7, "call_id" => "call-1" } }, response.parsed_body)
    assert_nil DurableAgent::Current.conversation_id
  end

  test "string results come back as strings" do
    run_tool "greet", arguments: { name: "Ada" }
    assert_equal({ "result" => "Hello Ada" }, response.parsed_body)
  end

  test "unknown tools are not found" do
    run_tool "nope", arguments: {}
    assert_response :not_found
    assert_match "nope", response.parsed_body["error"]
  end

  test "bad arguments, missing records and tool errors are 422 with the message" do
    run_tool "greet", arguments: { name: "Ada", mood: "happy" }
    assert_response :unprocessable_content
    assert_equal "unknown argument: mood", response.parsed_body["error"]

    run_tool "lookup_invoice", arguments: { number: "INV-2" }
    assert_response :unprocessable_content
    assert_equal "no invoice INV-2", response.parsed_body["error"]

    run_tool "explode", arguments: {}
    assert_response :unprocessable_content
    assert_equal "boom", response.parsed_body["error"]
  end

  private
    def auth(token = DurableAgent.config.token) = { "Authorization" => "Bearer #{token}" }

    def run_tool(name, **body)
      post "/durable_agent/tools/#{name}", params: body, headers: auth, as: :json
    end
end
