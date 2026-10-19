require "json"

module DurableAgent
  # Turns the sidecar's Postgres NOTIFY into app callbacks; by default a Turbo refresh of the conversation's
  # stream. Run one copy with `bin/rails durable_agent:relay`.
  #
  #   durable_agent_mirror   {"conversationId": 7, "entries": [18, 19], "docs": ["pi.live"]}
  #   durable_agent_mirror   {"conversationId": 7, "submission": {"id": 19, "status": "done"}}
  #   durable_agent_reports  {"id": 3, "type": "task_faulted", "conversationId": 7, "taskId": 12, "message": "..."}
  class Relay
    MIRROR = "durable_agent_mirror"
    REPORTS = "durable_agent_reports"
    CHANNELS = [ MIRROR, REPORTS ].freeze

    def run
      ActiveRecord::Base.connection_pool.with_connection do |connection|
        raw = connection.raw_connection
        CHANNELS.each { |channel| raw.exec("LISTEN #{channel}") }
        Rails.logger.info "durable_agent relay listening on #{CHANNELS.join(', ')}"

        loop do
          raw.wait_for_notify do |channel, _pid, payload|
            handle(channel, payload)
          rescue => error
            Rails.error.report(error, context: { channel: channel, payload: payload })
          end
        end
      end
    end

    def handle(channel, payload)
      payload = JSON.parse(payload) if payload.is_a?(String)

      case channel
      when MIRROR then mirrored(payload)
      when REPORTS then reported(payload)
      end
    end

    private
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
