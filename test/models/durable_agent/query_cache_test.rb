require "test_helper"

# The sidecar commits from another process while a request may already have read the same rows through the query
# cache. A second connection stands in for the sidecar, so these tests cannot run inside the fixtures' transaction;
# they work on rows of their own and delete them afterwards.
class DurableAgent::QueryCacheTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  setup do
    as_sidecar <<~SQL
      INSERT INTO durable_agent_conversations (id, record) VALUES (900091, '{"id":900091}');
      INSERT INTO durable_agent_documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record)
        VALUES (900591, '"pi.live"', 0, '""', 'conversation', 900091, 1, '{"id":900591}');
      INSERT INTO durable_agent_document_revisions (document_id, seq, kind, version, content) VALUES (900591, 1, 'base', 1, '{}');
    SQL
    @conversation = DurableAgent.conversation(900091)
  end

  teardown do
    as_sidecar <<~SQL
      DELETE FROM durable_agent_document_revisions WHERE document_id = 900591;
      DELETE FROM durable_agent_documents WHERE id = 900591;
      DELETE FROM durable_agent_entries WHERE conversation_id = 900091;
      DELETE FROM durable_agent_submissions WHERE conversation_id = 900091;
      DELETE FROM durable_agent_conversations WHERE id IN (900090, 900091);
    SQL
  end

  test "say drops the query cache, so busy? and transcript see what the sidecar committed" do
    ActiveRecord::Base.cache do
      assert_not @conversation.busy?
      assert_empty @conversation.transcript

      as_sidecar <<~SQL
        UPDATE durable_agent_document_revisions SET content = '{"run":{"taskId":1,"inputs":[900491]}}' WHERE document_id = 900591;
        INSERT INTO durable_agent_entries (id, conversation_id, commit_seq, record)
          VALUES (900190, 900091, 2, '{"id":900190,"conversationId":900091,"kind":"pi.user","model":[{"role":"user","content":"Hi"}]}');
        INSERT INTO durable_agent_submissions (id, conversation_id, request_id, status, record)
          VALUES (900491, 900091, '"m-1"', 'placed', '{"id":900491,"conversationId":900091,"requestId":"m-1","type":"input","status":"placed","entry":900190}');
      SQL
      assert_not @conversation.busy?, "the cached read is stale until a command clears it"

      stub_sidecar(submit: { "id" => 900491, "status" => "placed" })
      assert_equal 900491, @conversation.say("Hi", request_id: "m-1").id

      assert @conversation.busy?
      assert_equal [ "Hi" ], @conversation.transcript.map(&:text)
    end
  end

  test "abort drops the query cache" do
    as_sidecar %(UPDATE durable_agent_document_revisions SET content = '{"run":{"taskId":1}}' WHERE document_id = 900591;)

    ActiveRecord::Base.cache do
      assert @conversation.busy?
      as_sidecar "UPDATE durable_agent_document_revisions SET content = '{}' WHERE document_id = 900591;"

      stub_sidecar(abort: { "ok" => true })
      @conversation.abort

      assert_not @conversation.busy?
    end
  end

  test "start drops the query cache, so the new row is found" do
    ActiveRecord::Base.cache do
      assert_raises(ActiveRecord::RecordNotFound) { DurableAgent.conversation(900090) }
      as_sidecar %(INSERT INTO durable_agent_conversations (id, record) VALUES (900090, '{"id":900090}');)

      stub_sidecar(create_conversation: { "id" => 900090 })
      assert_equal 900090, DurableAgent.start.id
    end
  end

  private
    def as_sidecar(sql)
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do |connection|
          sql.split(/;\s*$/).map(&:strip).reject(&:empty?).each { |statement| connection.execute(statement) }
        end
      end.join
    end
end
