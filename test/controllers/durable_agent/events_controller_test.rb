require "test_helper"

class DurableAgent::EventsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @config = DurableAgent.config
    @changed, @reported = [], []
    @config.on_change = ->(conversation) { @changed << conversation }
    @config.on_report = ->(report) { @reported << report }
  end

  teardown { @config.on_change = @config.on_report = nil }

  test "requires the shared token" do
    post "/durable_agent/events", params: { conversations: [ 900001 ] }, as: :json
    assert_response :unauthorized

    post "/durable_agent/events", params: { conversations: [ 900001 ] }, headers: auth("wrong"), as: :json
    assert_response :unauthorized
    assert_empty @changed
  end

  test "calls on_change per conversation and on_report per report" do
    post_events conversations: [ 900001, 900002 ], reports: [ 900701 ]

    assert_response :no_content
    assert_equal [ durable_agent_conversations(:idle), durable_agent_conversations(:busy) ], @changed.sort_by(&:id)
    assert_equal [ durable_agent_reports(:faulted) ], @reported
  end

  test "unknown ids are skipped" do
    post_events conversations: [ 1, 900003 ], reports: [ 2 ]

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
