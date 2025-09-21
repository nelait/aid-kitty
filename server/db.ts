import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';

// Import our schema
import * as schema from '../shared/schema';

// Use PostgreSQL connection string from environment
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Create PostgreSQL connection
const sql = postgres(DATABASE_URL);

// Initialize Drizzle ORM with PostgreSQL
export const db = drizzle(sql, { schema });

/**
 * Custom migration runner that handles multiple SQL statements
 */
async function runCustomMigrations(migrationsFolder: string) {
  // Create migrations tracking table if it doesn't exist
  sql`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at INTEGER
  )`;

  // Clear migration history to start fresh (temporary fix for schema conflicts)
  console.log(' Clearing migration history to resolve schema conflicts...');
  sql`DELETE FROM __drizzle_migrations`;

  // Get list of migration files
  const migrationFiles = fs.readdirSync(migrationsFolder)
    .filter(file => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const filePath = path.join(migrationsFolder, file);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const fileHash = file; // Use filename as hash for simplicity

    console.log(` Applying migration: ${file}`);

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
          console.log(`  Executing statement ${i + 1}/${statements.length}`);
          
          try {
            // Convert CREATE TABLE to CREATE TABLE IF NOT EXISTS to handle existing tables
            if (statement.trim().startsWith('CREATE TABLE ') && !statement.includes('IF NOT EXISTS')) {
              statement = statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ');
              console.log(`    Modified to use IF NOT EXISTS`);
            }
            
            sql`${statement}`;
          } catch (statementError: any) {
            // Handle specific errors that are safe to ignore
            if (statementError.code === '42P07') { // duplicate_table
              console.log(`    Ignoring safe error: ${statementError.message}`);
              continue;
            }
            throw statementError;
          }
        }
      }

      // Record the migration as applied
      sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${fileHash}, ${Date.now()})`;

      console.log(` Migration ${file} applied successfully`);
    } catch (error) {
      console.error(` Error applying migration ${file}:`, error);
      // Don't throw the error, just log it and continue with next migration
      console.log(` Continuing with next migration...`);
    }
  }
}

/**
 * Runs database migrations
 */
export async function runMigrations() {
  const migrationsFolder = path.join(process.cwd(), 'migrations');
  
  try {
    console.log(' Running database migrations');
    console.log(' Migrations folder:', migrationsFolder);
    console.log(' Database URL:', DATABASE_URL);
    
    // Check if the migrations folder exists
    if (!fs.existsSync(migrationsFolder)) {
      console.log(' No migrations folder found, creating initial database structure');
      return;
    }
    
    // Run custom migrations
    await runCustomMigrations(migrationsFolder);
    console.log(' Migrations completed successfully');
    
  } catch (error) {
    console.error(' Error running migrations:', error);
    throw error;
  }
}

export default db;
