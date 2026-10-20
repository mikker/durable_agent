require "test_helper"

class SearchChatsTest < ActiveSupport::TestCase
  test "finds chats by title and by message text, newest activity first" do
    matches = SearchChats.run({ "query" => "invoice" })
    assert_equal [ chats(:invoice).id ], matches.map { it[:id] }
    assert_equal "What is invoice INV-1?", matches.first[:matched]

    by_text = SearchChats.run({ "query" => "totals 42" })
    assert_equal [ chats(:invoice).id ], by_text.map { it[:id] }
    assert_equal "INV-1 totals 42.", by_text.first[:matched]

    assert_equal [ chats(:invoice), chats(:poem), chats(:failed), chats(:errored) ].map(&:id), SearchChats.run({ "query" => "o" }).map { it[:id] }
  end

  test "limit is clamped, a blank query is refused, and the definition is replay-safe" do
    assert_equal 1, SearchChats.run({ "query" => "o", "limit" => 1 }).size
    assert_equal 4, SearchChats.run({ "query" => "o", "limit" => 50 }).size
    assert_raises(ArgumentError) { SearchChats.run({ "query" => "   " }) }
    assert_raises(ArgumentError) { SearchChats.run({}) }

    definition = SearchChats.to_definition
    assert_equal "search_chats", definition[:name]
    assert_equal "safe", definition[:replay]
    assert_equal [ "query" ], definition[:parameters][:required]
  end
end
