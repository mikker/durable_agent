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

ActiveRecord::Schema[8.1].define(version: 2026_10_19_000000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "durable_agent_conversations", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "parent_conversation_id"
    t.bigint "parent_at_entry_id"
    t.bigint "owner_conversation_id"
    t.bigint "owner_task_id"
    t.datetime "created_at", default: -> { "now()" }, null: false
    t.datetime "updated_at", default: -> { "now()" }, null: false
  end

  create_table "durable_agent_credentials", primary_key: "provider_id", id: :text, force: :cascade do |t|
    t.jsonb "credential", null: false
    t.datetime "updated_at", default: -> { "now()" }, null: false
  end

  create_table "durable_agent_documents", primary_key: ["conversation_id", "kind"], force: :cascade do |t|
    t.bigint "conversation_id", null: false
    t.text "kind", null: false
    t.jsonb "body", null: false
    t.datetime "updated_at", default: -> { "now()" }, null: false
  end

  create_table "durable_agent_entries", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "conversation_id", null: false
    t.text "kind", null: false
    t.jsonb "data"
    t.jsonb "model"
    t.bigint "head_entry_id"
    t.bigint "by_task_id"
    t.datetime "created_at", default: -> { "now()" }, null: false
    t.index ["conversation_id", "id"], name: "index_durable_agent_entries_on_conversation_id_and_id"
  end

  create_table "durable_agent_reports", force: :cascade do |t|
    t.text "type", null: false
    t.bigint "conversation_id"
    t.bigint "task_id"
    t.text "task_kind"
    t.text "extension"
    t.text "message", null: false
    t.jsonb "info", null: false
    t.datetime "created_at", default: -> { "now()" }, null: false
    t.index ["conversation_id", "id"], name: "index_durable_agent_reports_on_conversation_id_and_id"
  end

  create_table "durable_agent_settings", primary_key: "key", id: :text, force: :cascade do |t|
    t.text "value", null: false
    t.datetime "updated_at", default: -> { "now()" }, null: false
  end

  create_table "durable_agent_submissions", id: :bigint, default: nil, force: :cascade do |t|
    t.bigint "conversation_id", null: false
    t.text "request_id"
    t.text "type", null: false
    t.text "status", null: false
    t.bigint "entry_id"
    t.bigint "answer_entry_id"
    t.text "reason"
    t.jsonb "detail"
    t.datetime "created_at", default: -> { "now()" }, null: false
    t.datetime "updated_at", default: -> { "now()" }, null: false
    t.index ["conversation_id", "id"], name: "index_durable_agent_submissions_on_conversation_id_and_id"
    t.index ["request_id"], name: "index_durable_agent_submissions_on_request_id"
  end

  add_foreign_key "durable_agent_documents", "durable_agent_conversations", column: "conversation_id"
  add_foreign_key "durable_agent_entries", "durable_agent_conversations", column: "conversation_id"
  add_foreign_key "durable_agent_submissions", "durable_agent_conversations", column: "conversation_id"
end
