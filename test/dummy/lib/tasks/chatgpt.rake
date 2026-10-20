namespace :chatgpt do
  desc "Copy the ChatGPT sign-in from the old app's Postgres database (read-only there) into durable_agent_credentials"
  task :import, [ :database ] => :environment do |_, args|
    database = args[:database] || "slopdep_development"
    credential, status = Open3.capture2("psql", "-d", database, "-Atc", "select credential from agent_credentials where provider_id = 'openai'")
    abort "psql failed reading #{database}" unless status.success?
    abort "no openai credential in #{database}.agent_credentials" if credential.strip.empty?
    JSON.parse(credential) # refuse anything that is not JSON

    # Stored as the sidecar's legacy plaintext row; the sidecar re-encrypts it on its next write (a token refresh).
    sql = ActiveRecord::Base.sanitize_sql([ <<~SQL, credential.strip ])
      INSERT INTO durable_agent_credentials (provider_id, credential, updated_at) VALUES ('openai', ?, CURRENT_TIMESTAMP)
      ON CONFLICT (provider_id) DO UPDATE SET credential = excluded.credential, updated_at = excluded.updated_at
    SQL
    ActiveRecord::Base.connection.execute(sql)
    puts "Copied the openai credential from #{database}."
  end
end
