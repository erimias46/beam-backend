// Test DB helper — see specs/0004-test-harness.md.
//
// Connects to TEST_DATABASE_URL (separate from production DATABASE_URL),
// applies all migrations once per test process, exposes `resetDb()` to
// truncate between tests, and `seedUser(role)` / `seedBooking(...)` builders
// for the most common fixtures.

import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations')

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL?.replace(/\/[^/]+$/, '/beam0_test')
  || 'postgres://beam0:beam0@localhost:5432/beam0_test'

export const testPool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 })

let migrated = false

export async function migrateOnce() {
  if (migrated) return
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const applied = new Set(
    (await testPool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
  )
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const client = await testPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`Migration ${file} failed: ${err.message}`)
    } finally {
      client.release()
    }
  }
  migrated = true
}

/** Truncate every table except schema_migrations. Run before each test. */
export async function resetDb() {
  await migrateOnce()
  await testPool.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT tablename FROM pg_tables
         WHERE schemaname = current_schema()
           AND tablename != 'schema_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', r.tablename);
      END LOOP;
    END $$;
  `)
}

/** Insert a user with the given role. Returns the row. */
export async function seedUser({ role = 'customer', name = 'Test User', email = `test+${Math.random().toString(36).slice(2,8)}@beam0.example` } = {}) {
  const { rows } = await testPool.query(
    `INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *`,
    [name, email, role]
  )
  return rows[0]
}

/** Make the production pool point at the test DB. Must be called before
 *  importing the app — set TEST_DATABASE_URL via the env var, or call this
 *  helper to override it manually. */
export function pointAppPoolAtTestDb() {
  process.env.DATABASE_URL = TEST_DB_URL
}

export async function closeAll() {
  await testPool.end()
}
