require "test_helper"

# DurableAgent::TestHelper ships with the gem for apps' tests; the gem's own tests include it too.
class DurableAgent::TestHelperTest < ActiveSupport::TestCase
  test "stub_sidecar answers with values, callables or errors and records the calls" do
    stub_sidecar(auth: CONNECTED, submit: ->(id, content, **) { { "id" => id } }, abort: DurableAgent::Unavailable)

    assert_equal CONNECTED, DurableAgent.auth
    assert_equal({ "id" => 7 }, DurableAgent.client.submit(7, "Hi", request_id: 1))
    assert_raises(DurableAgent::Unavailable) { DurableAgent.client.abort(7) }
    assert_equal [ :auth, :submit, :abort ], sidecar_calls.map(&:first)
    assert_equal [ [ :submit, [ 7, "Hi" ], { request_id: 1 } ] ], sidecar_calls(:submit)
  end

  test "stub_sidecar refuses methods the client does not have" do
    assert_raises(ArgumentError) { stub_sidecar(nope: 1) }
  end

  test "fake_sidecar commits a conversation before answering, so start finds it" do
    fake_sidecar

    conversation = DurableAgent.start(instructions: "Be brief")

    assert_equal 950_001, conversation.id
    assert_equal({ "id" => 950_001 }, conversation.record)
    assert_not_nil conversation.created_at
    assert_equal 950_002, DurableAgent.start.id
    assert_equal [ { model: nil, instructions: "Be brief" }, { model: nil, instructions: nil } ], sidecar_calls(:create_conversation).map(&:last)
  end

  test "fake_sidecar commits a queued submission, idempotent on request_id" do
    fake_sidecar
    conversation = DurableAgent.start

    submission = conversation.say("Hello & <goodbye>", request_id: "a&b")

    assert submission.persisted?
    assert_equal [ "a&b", "queued", "input" ], [ submission.request_id, submission.status, submission.type ]
    assert_equal %("a&b"), submission.read_attribute(:request_id)
    assert_equal submission, conversation.submissions.for_request("a&b").sole
    assert_equal submission, conversation.say("Hello again", request_id: "a&b")
    assert_not_equal submission, conversation.say("Other", request_id: 2)
  end

  test "fake_sidecar answers abort, and refuses unknown conversations as the sidecar does" do
    fake_sidecar

    assert_equal({ "ok" => true }, durable_agent_conversations(:busy).abort)
    error = assert_raises(DurableAgent::Error) { DurableAgent.client.submit(2, "Hi", request_id: 1) }
    assert_equal 404, error.status
  end

  test "fake_sidecar takes other responses" do
    fake_sidecar(auth: DISCONNECTED)
    assert_equal DISCONNECTED, DurableAgent.auth
  end
end
