require "json"

module DurableAgent
  # pi-durable indexes some strings (task and document kinds, document keys, request ids) by their JSON encoding,
  # written in the sidecar by JavaScript's JSON.stringify. A lookup must produce the same bytes. Rails' to_json
  # escapes &, < and > (and U+2028/U+2029) as \uXXXX, which JSON.stringify never does; JSON.generate escapes only
  # what JSON requires, as JSON.stringify does.
  module IndexedString
    extend self

    def encode(value) = JSON.generate(value.to_s)
    def decode(text) = JSON.parse(text)
  end
end
