module DurableAgent
  # Turns pi messages (an entry's `model` column, or the streaming partial in pi.live) into plain text.
  # Content is either a string or an array of blocks: text, thinking, toolCall, image.
  module MessageText
    extend self

    def text(messages)
      blocks(messages).filter_map { |block| block.is_a?(String) ? block : (block["text"] if block["type"] == "text") }.join
    end

    def tool_calls(messages)
      blocks(messages).select { |block| block.is_a?(Hash) && block["type"] == "toolCall" }
    end

    def thinking?(messages)
      blocks(messages).any? { |block| block.is_a?(Hash) && block["type"] == "thinking" }
    end

    def blocks(messages)
      Array.wrap(messages).flat_map { |message| Array.wrap(message["content"]) }
    end
  end
end
