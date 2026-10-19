class CreateChats < ActiveRecord::Migration[8.1]
  def change
    create_table :chats do |t|
      t.string :title, null: false
      t.bigint :durable_agent_conversation_id, null: false

      t.timestamps
    end
    add_index :chats, :durable_agent_conversation_id
  end
end
