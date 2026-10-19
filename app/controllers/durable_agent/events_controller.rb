module DurableAgent
  # The sidecar posts the conversations and reports each commit touched, and the providers whose sign-in changed.
  # Events are a hint: the state is already in the database, so ids that do not exist are skipped and a failing
  # callback never fails the request.
  class EventsController < ApplicationController
    def create
      Conversation.where(id: ids("conversations")).each { |conversation| notify(:on_change, conversation, id: conversation.id) }
      Report.where(id: ids("reports")).each { |report| notify(:on_report, report, id: report.id) }
      notify(:on_auth, providers, providers: providers) if providers.any?
      head :no_content
    end

    private
      def ids(key)
        Array(params[key]).map(&:to_i)
      end

      def providers
        @providers ||= Array(params[:auth]).map(&:to_s).compact_blank.uniq
      end

      def notify(callback, argument, **context)
        DurableAgent.config.public_send(callback).call(argument)
      rescue => error
        Rails.error.report(error, context: { durable_agent: callback, **context })
      end
  end
end
