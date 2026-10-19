# Copied from the durable_agent gem (test/support/sidecar_stubs.rb).
# Replace DurableAgent.client calls with canned responses (or callables) and record what was called.
#
#   stub_sidecar(auth: { "openai" => { "type" => "oauth" } }, submit: ->(id, content, **) { { "id" => 1 } })
#   assert_equal 1, sidecar_calls(:submit).size
module SidecarStubs
  DISCONNECTED = { "openai" => nil, "anthropic" => nil }.freeze
  CONNECTED = { "openai" => { "type" => "oauth" }, "anthropic" => nil }.freeze

  def stub_sidecar(**responses)
    client = DurableAgent.client
    calls = sidecar_calls

    responses.each do |name, response|
      raise ArgumentError, "DurableAgent::Client has no method #{name}" unless client.respond_to?(name)
      (@sidecar_stubbed ||= []) << name
      client.define_singleton_method(name) do |*args, **kwargs|
        calls << [ name, args, kwargs ]
        if response.is_a?(Exception) || (response.is_a?(Class) && response < Exception)
          raise response
        else
          response.respond_to?(:call) ? response.call(*args, **kwargs) : response
        end
      end
    end
  end

  def sidecar_calls(name = nil)
    calls = (@sidecar_calls ||= [])
    name ? calls.select { |call| call.first == name } : calls
  end

  def teardown
    super
    Array(@sidecar_stubbed).uniq.each { |name| DurableAgent.client.singleton_class.send(:remove_method, name) }
    @sidecar_stubbed = @sidecar_calls = nil
  end
end
