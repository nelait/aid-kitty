import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables early
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Import our schema
import * as schema from '../shared/schema';

// Get DATABASE_URL after dotenv loads
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aidkitty';

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Initialize Drizzle ORM
export const db = drizzle(pool, { schema });

/**
 * Runs database migrations
 */
export async function runMigrations() {
  const migrationsFolder = path.join(process.cwd(), 'migrations');

  try {
    console.log('🔄 Running database migrations');
    console.log('📁 Migrations folder:', migrationsFolder);
    console.log('🗄️ Database URL:', DATABASE_URL.replace(/:[^:@]+@/, ':****@')); // Hide password

    // Use Drizzle's built-in migration for PostgreSQL
    await migrate(db, { migrationsFolder });

    console.log('✅ Migrations completed successfully');

  } catch (error: any) {
    // If migrations folder doesn't exist or no migrations, that's okay
    if (error.code === 'ENOENT') {
      console.log('📝 No migrations folder found, skipping migrations');
      return;
    }

    // If migrations already applied, that's okay too
    if (error.message?.includes('already been applied') || error.message?.includes('relation') && error.message?.includes('already exists')) {
      console.log('✅ Migrations already up to date');
      return;
    }

    console.error('❌ Error running migrations:', error);
    throw error;
  }
}

export default db;
