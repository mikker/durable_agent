require "test_helper"

class DurableAgent::DocumentTest < ActiveSupport::TestCase
  test "kind is stored JSON-encoded and read decoded" do
    live = durable_agent_documents(:idle_live)

    assert_equal %("pi.live"), live.read_attribute(:kind)
    assert_equal "pi.live", live.kind
    assert_nil live.key
    assert_equal [ durable_agent_documents(:idle_live), durable_agent_documents(:busy_live) ],
      DurableAgent::Document.of_kind("pi.live").order(:id).to_a
  end

  test "kinds and keys with characters Rails would escape match the sidecar's encoding" do
    DurableAgent::Document.insert({ id: 900590, kind: %("app.<notes>&co"), family: 1, key_value: %("é😀 & <b>"),
      scope_kind: "conversation", owner_id: 900004, created_at: 12, record: %({"id":900590}) })

    document = DurableAgent::Document.of_kind("app.<notes>&co").sole
    assert_equal [ "app.<notes>&co", "é😀 & <b>" ], [ document.kind, document.key ]
  end

  test "value is the content of the newest base revision" do
    assert_equal "Roses are red", durable_agent_documents(:busy_live).value.dig("generation", "message", "content", 0, "text")
    assert_equal({}, durable_agent_documents(:idle_live).value)
  end

  test "a delta after the newest base is not supported" do
    error = assert_raises(DurableAgent::Document::HistoryNotSupported) { durable_agent_documents(:forked_notes).value }
    assert_match "app.notes", error.message
  end

  test "revisions in commit order" do
    assert_equal [ [ 10, "base" ], [ 11, "delta" ] ], durable_agent_documents(:forked_notes).revisions.map { [ it.seq, it.kind ] }
    assert_equal({ "text" => "draft" }, durable_agent_document_revisions(:forked_notes_base).value)
  end

  test "a document without revisions has no value" do
    DurableAgent::Document::Revision.where(document_id: durable_agent_documents(:idle_live).id).delete_all
    assert_nil durable_agent_documents(:idle_live).value
    assert_equal({}, durable_agent_conversations(:idle).live)
  end

  test "current excludes retired incarnations" do
    assert durable_agent_documents(:idle_retired_inbox).retired?
    assert_not_includes DurableAgent::Document.current, durable_agent_documents(:idle_retired_inbox)
  end
end
