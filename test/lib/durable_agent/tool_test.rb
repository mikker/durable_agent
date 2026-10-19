require "test_helper"

class DurableAgent::ToolTest < ActiveSupport::TestCase
  class LookupInvoice < DurableAgent::Tool
    description "Fetch one invoice by number"
    param :number, :string, "Invoice number like INV-1042"
    param :include_lines, :boolean, "Include line items", required: false
    param :currency, :string, required: false, enum: %w[ EUR USD ]
    replay :safe

    def call(number:, include_lines: false, currency: "EUR")
      { number: number, include_lines: include_lines, currency: currency }
    end
  end

  class Ping < DurableAgent::Tool
    def call = "pong"
  end

  test "tool name is the underscored class name" do
    assert_equal "lookup_invoice", LookupInvoice.tool_name
    assert_equal "ping", Ping.tool_name
  end

  test "to_definition is a strict JSON Schema object" do
    assert_equal({
      name: "lookup_invoice",
      description: "Fetch one invoice by number",
      parameters: {
        type: "object",
        properties: {
          number: { type: "string", description: "Invoice number like INV-1042" },
          include_lines: { type: "boolean", description: "Include line items" },
          currency: { type: "string", enum: %w[ EUR USD ] }
        },
        required: [ "number" ],
        additionalProperties: false
      },
      replay: "safe"
    }, LookupInvoice.to_definition)
  end

  test "replay defaults to unsafe and a tool without params takes none" do
    definition = Ping.to_definition
    assert_equal "unsafe", definition[:replay]
    assert_equal({ type: "object", properties: {}, required: [], additionalProperties: false }, definition[:parameters])
    assert_equal "pong", Ping.run(nil)
  end

  test "run turns the JSON object into keyword arguments" do
    assert_equal({ number: "INV-1", include_lines: true, currency: "EUR" }, LookupInvoice.run("number" => "INV-1", "include_lines" => true))
  end

  test "null optional arguments fall back to the method's defaults" do
    assert_equal({ number: "INV-1", include_lines: false, currency: "EUR" }, LookupInvoice.run("number" => "INV-1", "currency" => nil))
  end

  test "unknown and missing arguments raise ArgumentError" do
    assert_raises(ArgumentError, match: "unknown argument: color") { LookupInvoice.run("number" => "1", "color" => "red") }
    assert_raises(ArgumentError, match: "missing required argument: number") { LookupInvoice.run({}) }
    assert_raises(ArgumentError, match: "must be an object") { LookupInvoice.run([ 1 ]) }
  end

  test "params, types and replay modes are checked when declared" do
    assert_raises(ArgumentError) { Class.new(DurableAgent::Tool) { param :x, :date } }
    assert_raises(ArgumentError) { Class.new(DurableAgent::Tool) { replay :maybe } }
  end

  test "subclasses inherit params without changing the parent" do
    child = Class.new(LookupInvoice) { param :note, :string, required: false }
    assert_includes child.params.keys, :note
    assert_not_includes LookupInvoice.params.keys, :note
    assert_equal :safe, child.replay
  end
end
