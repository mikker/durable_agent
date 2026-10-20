# An example read-only tool: the model searches this app's chats by title and message text. Records, queries
# and authorization stay in Ruby; the result is plain data the model can read.
class SearchChats < DurableAgent::Tool
  description "Search this app's chats by title or message text. Returns up to ten matches, newest activity first."
  param :query, :string, "Words to look for, case-insensitive"
  param :limit, :integer, "How many matches to return, 1 to 10", required: false
  replay :safe

  def call(query:, limit: 10)
    raise ArgumentError, "query must not be blank" if query.blank?
    limit = limit.clamp(1, 10)

    Chat.by_last_activity.includes(:conversation).filter_map { |chat| match(chat, query) }.first(limit)
  end

  private
    def match(chat, query)
      hit = chat.title.downcase.include?(query.downcase) ? chat.title : chat.transcript.map(&:text).find { |text| text.downcase.include?(query.downcase) }
      return unless hit

      { id: chat.id, title: chat.title, last_activity_at: chat.last_activity_at.iso8601, matched: hit.truncate(120) }
    end
end
