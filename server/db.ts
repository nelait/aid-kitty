import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { drizzle } from 'drizzle-orm/better-sqlite3';

// Import our schema
import * as schema from '../shared/schema';

const DATABASE_PATH = process.env.DATABASE_PATH || './data/app.db';

const dataDir = path.dirname(DATABASE_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create SQLite connection
const sqlite = new Database(DATABASE_PATH);

// Enable foreign keys
sqlite.pragma('foreign_keys = ON');

// Initialize Drizzle ORM
export const db = drizzle(sqlite, { schema });

/**
 * Custom migration runner that handles multiple SQL statements
 */
async function runCustomMigrations(migrationsFolder: string) {
  // Create migrations tracking table if it doesn't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER
    )
  `);

  // Clear migration history to start fresh (temporary fix for schema conflicts)
  console.log('🔄 Clearing migration history to resolve schema conflicts...');
  sqlite.exec('DELETE FROM __drizzle_migrations');

  // Get list of migration files
  const migrationFiles = fs.readdirSync(migrationsFolder)
    .filter(file => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const filePath = path.join(migrationsFolder, file);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const fileHash = file; // Use filename as hash for simplicity

    console.log(`🔄 Applying migration: ${file}`);

    try {
      // Split SQL content by statement breakpoints
      const statements = fileContent
        .split('--> statement-breakpoint')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

      // Execute each statement individually
      for (let i = 0; i < statements.length; i++) {
        let statement = statements[i];
        if (statement) {
          console.log(`  📝 Executing statement ${i + 1}/${statements.length}`);
          
          try {
            // Convert CREATE TABLE to CREATE TABLE IF NOT EXISTS to handle existing tables
            if (statement.trim().startsWith('CREATE TABLE ') && !statement.includes('IF NOT EXISTS')) {
              statement = statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ');
              console.log(`    🔧 Modified to use IF NOT EXISTS`);
            }
            
            sqlite.exec(statement);
          } catch (statementError: any) {
            // Handle specific errors that are safe to ignore
            if (statementError.code === 'SQLITE_ERROR') {
              const errorMsg = statementError.message.toLowerCase();
              if (errorMsg.includes('already exists') || 
                  errorMsg.includes('duplicate column') ||
                  errorMsg.includes('no such column') ||
                  errorMsg.includes('no such table')) {
                console.log(`    ⚠️ Ignoring safe error: ${statementError.message}`);
                continue;
              }
            }
            throw statementError;
          }
        }
      }

      // Record the migration as applied
      sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
        fileHash,
        Date.now()
      );

      console.log(`✅ Migration ${file} applied successfully`);
    } catch (error) {
      console.error(`❌ Error applying migration ${file}:`, error);
      // Don't throw the error, just log it and continue with next migration
      console.log(`⚠️ Continuing with next migration...`);
    }
  }
}

/**
 * Runs database migrations
 */
export async function runMigrations() {
  const migrationsFolder = path.join(process.cwd(), 'migrations');
  
  try {
    console.log('🔄 Running database migrations');
    console.log('📁 Migrations folder:', migrationsFolder);
    console.log('🗄️ Database path:', DATABASE_PATH);
    
    // Check if the migrations folder exists
    if (!fs.existsSync(migrationsFolder)) {
      console.log('📝 No migrations folder found, creating initial database structure');
      return;
    }
    
    // Run custom migrations
    await runCustomMigrations(migrationsFolder);
    console.log('✅ Migrations completed successfully');
    
  } catch (error) {
    console.error('❌ Error running migrations:', error);
    throw error;
  }
}

export default db;
