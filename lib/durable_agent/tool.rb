module DurableAgent
  # A tool the agent can call, written in Ruby. The sidecar fetches every tool's definition from
  # GET /durable_agent/tools and runs one with POST /durable_agent/tools/:name.
  #
  #   class LookupInvoice < DurableAgent::Tool
  #     description "Fetch one invoice by number"
  #     param :number, :string, "Invoice number like INV-1042"
  #     param :include_lines, :boolean, "Include line items", required: false
  #     replay :safe
  #
  #     def call(number:, include_lines: false)
  #       Invoice.find_by!(number:).as_json
  #     end
  #   end
  class Tool
    TYPES = %i[ string integer number boolean array object ].freeze
    REPLAY_MODES = %i[ safe unsafe ].freeze

    class_attribute :params, instance_accessor: false, default: {}

    class << self
      def description(text = nil)
        text ? @description = text : @description.to_s
      end

      # Extra JSON Schema keywords (enum:, items:, properties:) pass straight through.
      def param(name, type, description = nil, required: true, **schema)
        raise ArgumentError, "unknown param type #{type.inspect}" unless type.in?(TYPES)
        self.params = params.merge(name.to_sym => { type: type, description: description, required: required, schema: schema })
      end

      # Whether pi may run the tool again after a crash mid-call. Unsafe tools are reported instead of repeated.
      def replay(mode = nil)
        if mode
          raise ArgumentError, "replay is :safe or :unsafe" unless mode.in?(REPLAY_MODES)
          @replay = mode
        else
          @replay || (superclass.respond_to?(:replay) ? superclass.replay : :unsafe)
        end
      end

      def tool_name(name = nil)
        name ? @tool_name = name.to_s : @tool_name || self.name.demodulize.underscore
      end

      def to_definition
        {
          name: tool_name,
          description: description,
          parameters: {
            type: "object",
            properties: params.transform_values { |param| { type: param[:type].to_s, description: param[:description] }.compact.merge(param[:schema]) },
            required: params.select { |_, param| param[:required] }.keys.map(&:to_s),
            additionalProperties: false
          },
          replay: replay.to_s
        }
      end

      # Runs the tool with the arguments object the model produced (JSON, string keys).
      def run(arguments)
        new.call(**coerce(arguments))
      end

      def coerce(arguments)
        arguments ||= {}
        raise ArgumentError, "arguments must be an object" unless arguments.is_a?(Hash)
        arguments = arguments.transform_keys(&:to_s)

        unknown = arguments.keys - params.keys.map(&:to_s)
        raise ArgumentError, "unknown #{"argument".pluralize(unknown.size)}: #{unknown.join(", ")}" if unknown.any?

        # Models send null for optional arguments they skip; let the method's default apply instead.
        given = arguments.compact.transform_keys(&:to_sym)

        missing = params.select { |name, param| param[:required] && !given.key?(name) }.keys
        raise ArgumentError, "missing required #{"argument".pluralize(missing.size)}: #{missing.join(", ")}" if missing.any?

        given
      end
    end

    def call(**)
      raise NotImplementedError, "#{self.class.name} must implement #call"
    end
  end
end
