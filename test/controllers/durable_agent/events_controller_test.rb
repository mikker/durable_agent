require "test_helper"

class DurableAgent::EventsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @config = DurableAgent.config
    @changed, @reported, @signed_in = [], [], []
    @callbacks = [ @config.on_change, @config.on_report, @config.on_auth ]
    @config.on_change = ->(conversation) { @changed << conversation }
    @config.on_report = ->(report) { @reported << report }
    @config.on_auth = ->(providers) { @signed_in << providers }
  end

  # The dummy app's initializer sets its own callbacks; put them back for the app's tests.
  teardown { @config.on_change, @config.on_report, @config.on_auth = @callbacks }

  test "requires the shared token" do
    post "/durable_agent/events", params: { conversations: [ 900001 ] }, as: :json
    assert_response :unauthorized

    post "/durable_agent/events", params: { conversations: [ 900001 ] }, headers: auth("wrong"), as: :json
    assert_response :unauthorized
    assert_empty @changed
  end

  test "requires the Bearer scheme" do
    token = DurableAgent.config.token

    [ token, "bearer #{token}", "Basic #{token}", "Bearer  #{token}", "Bearer #{token} ", "Bearer" ].each do |authorization|
      post "/durable_agent/events", params: { conversations: [ 900001 ] }, headers: { "Authorization" => authorization }, as: :json
      assert_response :unauthorized, "#{authorization.inspect} must not authenticate"
    end
    assert_empty @changed

    post_events conversations: [ 900001 ]
    assert_response :no_content
  end

  test "calls on_change per conversation and on_report per report" do
    post_events conversations: [ 900001, 900002 ], reports: [ 900701 ]

    assert_response :no_content
    assert_equal [ durable_agent_conversations(:idle), durable_agent_conversations(:busy) ], @changed.sort_by(&:id)
    assert_equal [ durable_agent_reports(:faulted) ], @reported
  end

  test "unknown ids are skipped" do
    post_events conversations: [ 2, 900003 ], reports: [ 2 ]

    assert_response :no_content
    assert_equal [ durable_agent_conversations(:failed) ], @changed
    assert_empty @reported
  end

  test "an empty or partial body is fine" do
    post_events reports: [ 900702 ]
    assert_response :no_content
    assert_equal [ durable_agent_reports(:session) ], @reported
  end

  test "a failing callback is reported and the others still run" do
    @config.on_change = ->(conversation) { conversation.id == 900001 ? raise("boom") : @changed << conversation }

    assert_error_reported(RuntimeError) do
      post_events conversations: [ 900001, 900002 ], reports: [ 900701 ]
    end

    assert_response :no_content
    assert_equal [ durable_agent_conversations(:busy) ], @changed
    assert_equal [ durable_agent_reports(:faulted) ], @reported
  end

  test "auth events call on_auth once with the providers" do
    post_events auth: [ "openai", "anthropic" ]

    assert_response :no_content
    assert_equal [ %w[ openai anthropic ] ], @signed_in
    assert_empty @changed
  end

  test "no auth key, no on_auth" do
    post_events conversations: [ 900001 ], auth: []
    assert_empty @signed_in
  end

  test "the default on_auth broadcasts a refresh to durable_agent:auth" do
    @config.on_auth = nil

    streams = capture_turbo_stream_broadcasts("durable_agent:auth") { post_events auth: [ "openai" ] }

    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "auth ids arrive scoped as given" do
    post_events auth: [ "openai@u42", "openai" ]
    assert_equal [ %w[ openai@u42 openai ] ], @signed_in
  end

  test "the default on_auth also broadcasts to each account's stream" do
    @config.on_auth = nil

    app, u42, u7 = nil
    u7 = capture_turbo_stream_broadcasts("durable_agent:auth:u7") do
      u42 = capture_turbo_stream_broadcasts("durable_agent:auth:u42") do
        app = capture_turbo_stream_broadcasts("durable_agent:auth") { post_events auth: [ "openai@u42", "anthropic@u42", "openai@u7" ] }
      end
    end

    assert_equal [ "refresh" ], app.map { it["action"] }
    assert_equal [ "refresh" ], u42.map { it["action"] }
    assert_equal [ "refresh" ], u7.map { it["action"] }
  end

  test "the default on_report broadcasts a report without a conversation to durable_agent:reports" do
    @config.on_report = nil

    streams = capture_turbo_stream_broadcasts("durable_agent:reports") { post_events reports: [ 900702 ] }

    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  test "the default on_change broadcasts a refresh to the conversation" do
    @config.on_change = nil
    conversation = durable_agent_conversations(:idle)

    streams = capture_turbo_stream_broadcasts(conversation) { post_events conversations: [ conversation.id ] }

    assert_equal [ "refresh" ], streams.map { it["action"] }
  end

  private
    def auth(token = DurableAgent.config.token) = { "Authorization" => "Bearer #{token}" }

    def post_events(**body)
      post "/durable_agent/events", params: body, headers: auth, as: :json
    end
end
