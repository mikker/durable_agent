# An example tool: the model calls it to learn the current time, which it otherwise cannot know.
class CurrentTime < DurableAgent::Tool
  description "The current date and time, in ISO 8601, in the given IANA time zone or the app's default"
  param :time_zone, :string, "An IANA time zone such as Europe/Copenhagen", required: false
  replay :safe

  def call(time_zone: nil)
    zone = time_zone ? ActiveSupport::TimeZone[time_zone] : Time.zone
    raise ArgumentError, "unknown time zone #{time_zone}" unless zone

    zone.now.iso8601
  end
end
