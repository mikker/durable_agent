# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_10_19_203400) do
  create_table "chats", force: :cascade do |t|
    t.string "title", null: false
    t.bigint "durable_agent_conversation_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["durable_agent_conversation_id"], name: "index_chats_on_durable_agent_conversation_id"
  end

  create_table "durable_agent_conversations", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "owner_conversation_id"
    t.bigint "owner_task_id"
    t.text "record", null: false
    t.index ["owner_conversation_id", "id"], name: "durable_agent_conversations_by_owner_conversation"
    t.index ["owner_task_id", "id"], name: "durable_agent_conversations_by_owner_task"
  end

  create_table "durable_agent_credentials", primary_key: "provider_id", id: :text, force: :cascade do |t|
    t.text "credential", null: false
    t.datetime "updated_at", null: false
  end

  create_table "durable_agent_document_revisions", primary_key: ["document_id", "seq"], force: :cascade do |t|
    t.bigint "document_id", null: false
    t.bigint "seq", null: false
    t.text "kind", null: false
    t.bigint "version", null: false
    t.text "content", null: false
    t.index ["document_id", "kind", "seq"], name: "durable_agent_document_revisions_by_kind", order: { seq: :desc }
  end

  create_table "durable_agent_documents", id: :bigint, default: nil, force: :cascade do |t|
    t.text "kind", null: false
    t.integer "family", null: false
    t.text "key_value", null: false
    t.text "scope_kind", null: false
    t.bigint "owner_id", null: false
    t.bigint "created_at", null: false
    t.bigint "retired_at"
    t.text "record", null: false
    t.index ["kind", "scope_kind", "owner_id", "family", "key_value", "created_at", "retired_at"], name: "durable_agent_documents_by_address", order: { created_at: :desc }
    t.index ["scope_kind", "owner_id", "id"], name: "durable_agent_documents_by_scope"
    t.index ["scope_kind", "owner_id", "kind", "id"], name: "durable_agent_documents_by_scope_kind"
  end

  create_table "durable_agent_durable_metadata", primary_key: "singleton", force: :cascade do |t|
    t.text "next_id", null: false
    t.bigint "next_seq", null: false
  end

  create_table "durable_agent_durable_schema", primary_key: "singleton", force: :cascade do |t|
    t.integer "version", null: false
  end

  create_table "durable_agent_entries", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "conversation_id", null: false
    t.bigint "head"
    t.bigint "commit_seq", null: false
    t.text "record", null: false
    t.index ["conversation_id", "id"], name: "durable_agent_entries_by_conversation", order: { id: :desc }
    t.index ["conversation_id", "id"], name: "durable_agent_entry_heads_by_conversation", order: { id: :desc }, where: "head IS NOT NULL"
  end

  create_table "durable_agent_record_ids", id: :bigint, default: nil, force: :cascade do |t|
    t.text "record_type", null: false
  end

  create_table "durable_agent_reports", force: :cascade do |t|
    t.text "type", null: false
    t.bigint "conversation_id"
    t.bigint "task_id"
    t.text "task_kind"
    t.text "extension"
    t.text "message", null: false
    t.text "info", null: false
    t.datetime "created_at", null: false
    t.index ["conversation_id", "id"], name: "index_durable_agent_reports_on_conversation_id_and_id"
  end

  create_table "durable_agent_settings", primary_key: "key", id: :text, force: :cascade do |t|
    t.text "value", null: false
    t.datetime "updated_at", null: false
  end

  create_table "durable_agent_submissions", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "conversation_id", null: false
    t.text "request_id"
    t.text "status", null: false
    t.text "record", null: false
    t.index ["conversation_id", "id"], name: "durable_agent_submissions_by_conversation"
    t.index ["conversation_id", "request_id"], name: "durable_agent_submissions_by_request"
    t.index ["status", "id"], name: "durable_agent_submissions_by_status"
  end

  create_table "durable_agent_tasks", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "conversation_id", null: false
    t.text "kind", null: false
    t.text "status", null: false
    t.integer "abort_requested", null: false
    t.integer "background", null: false
    t.text "record", null: false
    t.index ["abort_requested", "id"], name: "durable_agent_tasks_by_abort_requested"
    t.index ["background", "id"], name: "durable_agent_tasks_by_background"
    t.index ["conversation_id", "id"], name: "durable_agent_tasks_by_conversation"
    t.index ["kind", "id"], name: "durable_agent_tasks_by_kind"
    t.index ["status", "id"], name: "durable_agent_tasks_by_status"
  end
end
