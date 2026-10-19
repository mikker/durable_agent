require "test_helper"

# The expected strings are written by hand from JSON.stringify's rules: it escapes only the quote, the backslash
# and control characters, never &, <, >, non-ASCII or U+2028.
class DurableAgent::IndexedStringTest < ActiveSupport::TestCase
  ENCODINGS = {
    "a&b" => %("a&b"),
    "<x>" => %("<x>"),
    %("q") => %("\\"q\\""),
    "é😀" => %("é😀"),
    " " => %(" "),
    "back\\slash" => %("back\\\\slash"),
    "line\nbreak" => %("line\\nbreak"),
    "" => %("")
  }

  test "encodes as JSON.stringify does" do
    ENCODINGS.each do |value, encoded|
      assert_equal encoded, DurableAgent::IndexedString.encode(value), "encoding #{value.inspect}"
      assert_equal value, DurableAgent::IndexedString.decode(encoded)
    end
  end

  test "Rails' to_json would not match" do
    assert_not_equal %("a&b"), "a&b".to_json
  end

  test "non-strings are encoded as their string form, as the client sends request ids" do
    assert_equal %("42"), DurableAgent::IndexedString.encode(42)
    assert_equal %("pi.live"), DurableAgent::IndexedString.encode(:"pi.live")
  end
end
