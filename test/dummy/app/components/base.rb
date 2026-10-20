# frozen_string_literal: true

class Components::Base < Phlex::HTML
  # Nitro Kit components as capitalized Kit methods: Button(...), Card(...), Flex(...).
  include NitroKit

  include Phlex::Rails::Helpers::Routes
  include Phlex::Rails::Helpers::DOMID
  include Phlex::Rails::Helpers::FormWith
  include Phlex::Rails::Helpers::SimpleFormat
  include Phlex::Rails::Helpers::TimeAgoInWords
  include Phlex::Rails::Helpers::TimeTag
  include Phlex::Rails::Helpers::NumberWithDelimiter
  include Phlex::Rails::Helpers::NumberToCurrency
  include Phlex::Rails::Helpers::TurboStreamFrom
  include Phlex::Rails::Helpers::ContentFor

  if Rails.env.development?
    def before_template
      comment { "Before #{self.class.name}" }
      super
    end
  end
end
