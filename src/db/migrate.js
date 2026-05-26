import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { pool } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dir = join(__dirname, 'migrations')

const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8')
  try {
    await pool.query(sql)
    console.log(`✓ ${file}`)
  } catch (err) {
    console.error(`✗ ${file}: ${err.message}`)
    process.exit(1)
  }
}

console.log('Migrations applied successfully.')
process.exit(0)
