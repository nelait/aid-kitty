import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const dbPath = path.join(__dirname, 'data', 'app.db');

// Migration file path
const migrationPath = path.join(__dirname, 'migrations', '0007_create_chat_templates.sql');

console.log('🔄 Running chat templates migration...');

try {
  // Open database connection
  const db = new Database(dbPath);
  
  // Read migration file
  const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
  
  // Split by semicolon to handle multiple statements
  const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
  
  // Execute each statement
  statements.forEach((statement, index) => {
    if (statement.trim()) {
      try {
        db.exec(statement.trim());
        console.log(`✅ Executed statement ${index + 1}`);
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log(`⚠️  Statement ${index + 1} - Table already exists, skipping`);
        } else {
          throw error;
        }
      }
    }
  });
  
  // Verify the table was created
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='chat_templates'
  `).get();
  
  if (tableExists) {
    console.log('✅ Chat templates table created successfully');
    
    // Check if default templates were inserted
    const templateCount = db.prepare('SELECT COUNT(*) as count FROM chat_templates').get();
    console.log(`📊 Default templates inserted: ${templateCount.count}`);
  } else {
    console.log('❌ Failed to create chat templates table');
  }
  
  // Close database connection
  db.close();
  
  console.log('🎉 Chat templates migration completed successfully!');
  
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}
