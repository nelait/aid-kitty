import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Database path
const DATABASE_PATH = process.env.DATABASE_PATH || './data/app.db';

console.log('🔄 Manually applying generated_documents migration...');
console.log('🗄️ Database path:', DATABASE_PATH);

try {
  // Open database
  const db = new Database(DATABASE_PATH);
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Read and execute the migration SQL
  const migrationSQL = `
    CREATE TABLE IF NOT EXISTS generated_documents (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      model text NOT NULL,
      document_type text NOT NULL,
      content text NOT NULL,
      tokens_used integer,
      generation_time real,
      created_at integer,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
    );
  `;
  
  console.log('📝 Executing migration SQL...');
  db.exec(migrationSQL);
  
  // Verify table was created
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='generated_documents'").all();
  
  if (tables.length > 0) {
    console.log('✅ Migration completed successfully!');
    console.log('📊 generated_documents table created');
  } else {
    console.log('❌ Table creation failed');
  }
  
  db.close();
  
} catch (error) {
  console.error('❌ Error applying migration:', error);
  process.exit(1);
}
