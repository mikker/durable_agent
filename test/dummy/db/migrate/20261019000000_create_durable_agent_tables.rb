# The durable_agent_* tables mirror pi-durable's committed state. The sidecar is their only writer; Rails reads.
# IDs are pi's own integer ids (no sequence, `default: nil`), so a row points straight at the harness record. Matches the gem's
# sidecar/sql/schema.sql (mirror schema v1).
class CreateDurableAgentTables < ActiveRecord::Migration[8.1]
  def change
    create_table :durable_agent_conversations, id: false do |t|
      t.bigint :id, primary_key: true, default: nil
      t.bigint :parent_conversation_id
      t.bigint :parent_at_entry_id
      t.bigint :owner_conversation_id
      t.bigint :owner_task_id
      t.timestamps default: -> { "now()" }
    end

    create_table :durable_agent_entries, id: false do |t|
      t.bigint :id, primary_key: true, default: nil
      t.references :conversation, null: false, foreign_key: { to_table: :durable_agent_conversations }, index: false
      t.text :kind, null: false
      t.jsonb :data
      t.jsonb :model
      t.bigint :head_entry_id
      t.bigint :by_task_id
      t.datetime :created_at, null: false, default: -> { "now()" }
      t.index [ :conversation_id, :id ]
    end

    create_table :durable_agent_documents, primary_key: [ :conversation_id, :kind ] do |t|
      t.references :conversation, null: false, foreign_key: { to_table: :durable_agent_conversations }, index: false
      t.text :kind, null: false
      t.jsonb :body, null: false
      t.datetime :updated_at, null: false, default: -> { "now()" }
    end

    create_table :durable_agent_submissions, id: false do |t|
      t.bigint :id, primary_key: true, default: nil
      t.references :conversation, null: false, foreign_key: { to_table: :durable_agent_conversations }, index: false
      t.text :request_id
      t.text :type, null: false
      t.text :status, null: false
      t.bigint :entry_id
      t.bigint :answer_entry_id
      t.text :reason
      t.jsonb :detail
      t.timestamps default: -> { "now()" }
      t.index [ :conversation_id, :id ]
      t.index :request_id
    end

    create_table :durable_agent_reports do |t|
      t.text :type, null: false
      t.bigint :conversation_id
      t.bigint :task_id
      t.text :task_kind
      t.text :extension
      t.text :message, null: false
      t.jsonb :info, null: false
      t.datetime :created_at, null: false, default: -> { "now()" }
      t.index [ :conversation_id, :id ]
    end

    # Provider credentials (OAuth tokens) the sidecar stores. Rails has no model for this table on purpose;
    # connection status comes from the sidecar's GET /auth.
    create_table :durable_agent_credentials, id: false do |t|
      t.text :provider_id, primary_key: true
      t.jsonb :credential, null: false
      t.datetime :updated_at, null: false, default: -> { "now()" }
    end

    # device_id and schema_version, written by the sidecar.
    create_table :durable_agent_settings, id: false do |t|
      t.text :key, primary_key: true
      t.text :value, null: false
      t.datetime :updated_at, null: false, default: -> { "now()" }
    end
  end
end
