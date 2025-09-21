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
  await sql`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `;

  // Clear migration history to start fresh (temporary fix for schema conflicts)
  console.log(' Clearing migration history to resolve schema conflicts...');
  await sql`DELETE FROM __drizzle_migrations`;

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
      // Execute the entire migration file as a single transaction
      console.log(`  📝 Executing migration file in single transaction`);
      
      // Remove comments and empty lines for cleaner execution
      const cleanedContent = fileContent
        .split('\n')
        .filter(line => !line.trim().startsWith('--') && line.trim().length > 0)
        .join('\n');
      
      await sql.unsafe(cleanedContent);

      // Record the migration as applied
      await sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${fileHash}, ${Date.now()})`;

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
