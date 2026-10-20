module DurableAgent
  # Test support for apps built on durable_agent. In test/test_helper.rb:
  #
  #   require "durable_agent/test_helper"
  #
  #   class ActiveSupport::TestCase
  #     include DurableAgent::TestHelper
  #   end
  #
  # `stub_sidecar` replaces DurableAgent.client calls with canned responses or callables and records each call.
  # It also seals the client: every other call raises DurableAgent::Unavailable, so a test never reaches a sidecar
  # that happens to be running. `fake_sidecar` goes further for the three commands that write: like the real sidecar,
  # it commits the conversation or submission row before it answers, so `DurableAgent.start` and `conversation.say`
  # find them.
  #
  #   fake_sidecar
  #   chat = Chat.create!                      # calls DurableAgent.start
  #   chat.conversation.say("Hi", request_id: 1)
  #   assert_equal 1, sidecar_calls(:submit).size
  module TestHelper
    DISCONNECTED = { "openai" => nil, "anthropic" => nil }.freeze
    CONNECTED = { "openai" => { "type" => "oauth", "source" => "OAuth" }, "anthropic" => nil }.freeze

    # Ids the fake hands out: above the ids pi-durable starts from, and above the gem's own test fixtures.
    FAKE_IDS_FROM = 950_000

    # The client's calls to the sidecar; `url` and `token` are configuration.
    SIDECAR_CALLS = DurableAgent::Client.public_instance_methods(false) - %i[ url token ]

    #   stub_sidecar(auth: CONNECTED, submit: ->(id, content, **) { { "id" => 1 } }, abort: DurableAgent::Unavailable)
    def stub_sidecar(**responses)
      client = DurableAgent.client
      responses.each_key { |name| raise ArgumentError, "DurableAgent::Client has no method #{name}" unless client.respond_to?(name) }

      @sidecar_stubbed ||= []
      sealed = (SIDECAR_CALLS - @sidecar_stubbed - responses.keys).index_with do |name|
        ->(*, **) { raise DurableAgent::Unavailable.new(nil, nil, "DurableAgent.client.#{name} is not stubbed; stub_sidecar(#{name}: ...)") }
      end

      calls = sidecar_calls
      responses.merge(sealed).each do |name, response|
        @sidecar_stubbed << name
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

    # Every stubbed call as [name, args, kwargs], or only those of one name.
    def sidecar_calls(name = nil)
      calls = (@sidecar_calls ||= [])
      name ? calls.select { |call| call.first == name } : calls
    end

    # create_conversation, submit and abort answered as the sidecar answers them, after committing the rows it
    # commits. Submissions are idempotent on request_id, and an unknown conversation is a 404, as on the sidecar.
    # Further responses stub other calls: fake_sidecar(auth: CONNECTED).
    def fake_sidecar(**responses)
      stub_sidecar(create_conversation: method(:fake_create_conversation), submit: method(:fake_submit),
        abort: method(:fake_abort), **responses)
    end

    def teardown
      super
      Array(@sidecar_stubbed).uniq.each { |name| DurableAgent.client.singleton_class.send(:remove_method, name) }
      @sidecar_stubbed = @sidecar_calls = @fake_sidecar_id = nil
    end

    private
      def fake_create_conversation(model: nil, instructions: nil, account: nil)
        id = next_fake_sidecar_id
        DurableAgent::Conversation.insert({ id: id, record: { id: id } })
        { "id" => id }
      end

      def fake_submit(conversation_id, content, request_id:, when_busy: nil)
        fake_conversation!(conversation_id)

        submission = DurableAgent::Submission.where(conversation_id: conversation_id).for_request(request_id).first
        submission ||= begin
          id = next_fake_sidecar_id
          DurableAgent::Submission.insert({ id: id, conversation_id: conversation_id, request_id: DurableAgent::IndexedString.encode(request_id),
            status: "queued", record: { id: id, conversationId: conversation_id, requestId: request_id.to_s, type: "input", status: "queued" } })
          DurableAgent::Submission.find(id)
        end

        { "id" => submission.id, "status" => submission.status }
      end

      def fake_abort(conversation_id)
        fake_conversation!(conversation_id)
        { "ok" => true }
      end

      def fake_conversation!(id)
        unless DurableAgent::Conversation.exists?(id)
          raise DurableAgent::Error.new(404, { "error" => "conversation #{id} not found" })
        end
      end

      def next_fake_sidecar_id
        @fake_sidecar_id = (@fake_sidecar_id || FAKE_IDS_FROM) + 1
      end
  end
end
