module DurableAgent
  # Whose provider credentials a conversation runs on: an app-chosen string, typically a user id. On the sidecar an
  # account scopes the provider id, so "openai@u42" is account u42's OpenAI and "openai@u42/gpt-6.1-sol" its model
  # ref. A provider id without "@" is the app's own.
  module Account
    PATTERN = /\A[A-Za-z0-9_.-]{1,64}\z/

    class << self
      # nil for the app's own account; raises ArgumentError for a value outside PATTERN.
      def normalize(value)
        return if value.blank?

        value.to_s.tap do |account|
          raise ArgumentError, "invalid account #{account.inspect}" unless PATTERN.match?(account)
        end
      end

      def scoped(provider, account)
        account ? "#{provider}@#{account}" : provider.to_s
      end

      # "openai@u42" => ["openai", "u42"]; "openai" => ["openai", nil].
      def parse(scoped_provider)
        provider, account = scoped_provider.to_s.split("@", 2)
        [ provider, account.presence ]
      end
    end
  end
end
