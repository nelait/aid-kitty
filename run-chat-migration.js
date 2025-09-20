import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Connect to the database
const dbPath = join(__dirname, 'data', 'app.db');
const db = new Database(dbPath);

try {
  console.log('🔄 Updating chat_messages table structure...');
  
  // Drop the old chat_messages table if it exists
  db.exec('DROP TABLE IF EXISTS chat_messages');
  
  // Create the new chat_messages table with correct structure
  db.exec(`
    CREATE TABLE chat_messages (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      project_id text,
      provider text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      metadata text,
      created_at integer,
      FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  
  console.log('✅ Chat messages table updated successfully!');
  
} catch (error) {
  console.error('❌ Error updating chat_messages table:', error);
} finally {
  db.close();
}
