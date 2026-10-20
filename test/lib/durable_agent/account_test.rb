require "test_helper"

class DurableAgent::AccountTest < ActiveSupport::TestCase
  test "normalize leaves nil and blank as the app's own account" do
    assert_nil DurableAgent::Account.normalize(nil)
    assert_nil DurableAgent::Account.normalize("")
    assert_nil DurableAgent::Account.normalize("  ")
  end

  test "normalize turns a valid value into a string" do
    assert_equal "u42", DurableAgent::Account.normalize("u42")
    assert_equal "42", DurableAgent::Account.normalize(42)
    assert_equal "a.b_c-D9", DurableAgent::Account.normalize(:"a.b_c-D9")
    assert_equal "x" * 64, DurableAgent::Account.normalize("x" * 64)
  end

  test "normalize rejects anything outside the pattern" do
    [ "u@42", "u/42", "u 42", "ü", "x" * 65, "u42\n" ].each do |value|
      assert_raises(ArgumentError, match: "invalid account") { DurableAgent::Account.normalize(value) }
    end
  end

  test "scoped and parse" do
    assert_equal "openai@u42", DurableAgent::Account.scoped("openai", "u42")
    assert_equal "openai", DurableAgent::Account.scoped("openai", nil)

    assert_equal [ "openai", "u42" ], DurableAgent::Account.parse("openai@u42")
    assert_equal [ "openai", nil ], DurableAgent::Account.parse("openai")
  end
end
