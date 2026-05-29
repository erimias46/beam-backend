import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { pool } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dir = join(__dirname, 'migrations')

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`)

const applied = new Set(
  (await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
)

const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

for (const file of files) {
  if (applied.has(file)) {
    console.log(`= ${file} (already applied)`)
    continue
  }
  const sql = readFileSync(join(dir, file), 'utf8')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    await client.query('COMMIT')
    console.log(`✓ ${file}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(`✗ ${file}: ${err.message}`)
    process.exit(1)
  } finally {
    client.release()
  }
}

console.log('Migrations applied successfully.')
process.exit(0)
