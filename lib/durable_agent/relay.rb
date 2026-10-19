require "json"

module DurableAgent
  # Turns the sidecar's Postgres NOTIFY into app callbacks; by default a Turbo refresh of the conversation's
  # stream. Run one copy with `bin/rails durable_agent:relay`.
  #
  #   durable_agent_mirror   {"conversationId": 7, "entries": [18, 19], "docs": ["pi.live"]}
  #   durable_agent_mirror   {"conversationId": 7, "submission": {"id": 19, "status": "done"}}
  #   durable_agent_reports  {"id": 3, "type": "task_faulted", "conversationId": 7, "taskId": 12, "message": "..."}
  #
  # The listening connection is supervised: when no notification arrives for `wait` seconds the relay sends a
  # heartbeat, and any connection failure discards that connection and reconnects with backoff. NOTIFYs sent
  # while disconnected are lost, so after a reconnect every conversation updated since the last contact gets
  # `on_mirror` with no entries, docs or submission.
  class Relay
    MIRROR = "durable_agent_mirror"
    REPORTS = "durable_agent_reports"
    CHANNELS = [ MIRROR, REPORTS ].freeze
    MAX_BACKOFF = 30

    def initialize(pool: ActiveRecord::Base.connection_pool, wait: 30, sleeper: ->(seconds) { sleep seconds }, clock: -> { Time.current })
      @pool, @wait, @sleeper, @clock = pool, wait, sleeper, clock
      @stopped = false
    end

    def run
      backoff, lost_at = 1, nil

      until @stopped
        begin
          listening do |raw|
            backoff = 1
            catch_up(since: lost_at) if lost_at
            lost_at = nil
            relay(raw) until @stopped
          end
        rescue PG::Error, ActiveRecord::ConnectionNotEstablished, ActiveRecord::StatementInvalid => error
          lost_at ||= @last_contact
          Rails.error.report(error, context: { relay: "connection lost" })
          Rails.logger.warn "durable_agent relay lost its connection (#{error.class}: #{error.message.squish}); reconnecting in #{backoff}s"
          @sleeper.call(backoff) unless @stopped
          backoff = [ backoff * 2, MAX_BACKOFF ].min
        end
      end
    end

    # Takes effect within `wait` seconds.
    def stop = @stopped = true

    def handle(channel, payload)
      payload = JSON.parse(payload) if payload.is_a?(String)

      case channel
      when MIRROR then mirrored(payload)
      when REPORTS then reported(payload)
      end
    end

    private
      # The connection is never returned to the pool: after a failure it may be broken, and on a clean stop it
      # is still LISTENing.
      def listening
        connection = @pool.checkout
        raw = connection.raw_connection
        CHANNELS.each { |channel| raw.exec("LISTEN #{channel}") }
        @last_contact = @clock.call
        Rails.logger.info "durable_agent relay listening on #{CHANNELS.join(', ')}"
        yield raw
      ensure
        if connection
          @pool.remove(connection)
          connection.disconnect!
        end
      end

      def relay(raw)
        notified = raw.wait_for_notify(@wait) do |channel, _pid, payload|
          handle(channel, payload)
        rescue => error
          Rails.error.report(error, context: { channel: channel, payload: payload })
        end
        heartbeat(raw) unless notified
        @last_contact = @clock.call
      end

      # A silently dropped TCP session never wakes wait_for_notify, and a plain exec would block on it for the
      # kernel's retransmission timeout, so the heartbeat waits for its answer for `wait` seconds at most.
      def heartbeat(raw)
        raw.send_query("SELECT 1")
        raw.block(@wait) or raise PG::ConnectionBad, "heartbeat got no answer within #{@wait}s"
        raw.get_last_result
      end

      def catch_up(since:)
        Conversation.where(updated_at: since..).find_each do |conversation|
          DurableAgent.config.on_mirror.call(conversation, entries: [], docs: [], submission: nil)
        rescue => error
          Rails.error.report(error, context: { relay: "catch-up", conversation_id: conversation.id })
        end
      end

      def mirrored(payload)
        conversation = Conversation.find(payload.fetch("conversationId"))
        entries = conversation.entries.where(id: Array(payload["entries"])).chronologically.to_a
        submission = Submission.find_by(id: payload.dig("submission", "id")) if payload["submission"]

        DurableAgent.config.on_mirror.call(conversation, entries: entries, docs: Array(payload["docs"]), submission: submission)
      end

      def reported(payload)
        DurableAgent.config.on_report.call(Report.find(payload.fetch("id")))
      end
  end
end
