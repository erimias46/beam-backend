#!/usr/bin/env node
// Demo seed — creates test accounts for local/staging QA.
// Safe to run multiple times (upserts by email).
// Usage: node src/db/seed-demo.js

import { query } from './index.js'

const DEMO_USERS = [
  // Customers
  { name: 'Alex Rivera',   email: 'alex@beam0.demo',    role: 'customer' },
  { name: 'Jordan Kim',    email: 'jordan@beam0.demo',  role: 'customer' },
  { name: 'Taylor Brooks', email: 'taylor@beam0.demo',  role: 'customer' },
  // Barbers
  { name: 'Marcus Johnson', email: 'marcus@beam0.demo', role: 'barber',
    bio: '8 years of precision cuts. ATL native. Specialising in fades, tapers & beard sculpting.',
    years_experience: 8, price_cents: 4500 },
  { name: 'Devon Carter',   email: 'devon@beam0.demo',  role: 'barber',
    bio: 'Certified master barber. Known for clean lines and creative designs.',
    years_experience: 5, price_cents: 3500 },
  { name: 'Malik Thompson', email: 'malik@beam0.demo',  role: 'barber',
    bio: 'Fresh cuts, old-school vibes. Specialising in fades and designs.',
    years_experience: 3, price_cents: 3000 },
  // Admin
  { name: 'Beam Admin', email: 'admin@beam0.demo', role: 'admin' },
]

const BARBER_SERVICES = [
  { name: 'Fade',                  price_cents: 3500, duration_min: 45 },
  { name: 'Lineup',                price_cents: 2500, duration_min: 20 },
  { name: 'Full Cut + Beard Trim', price_cents: 6000, duration_min: 75 },
  { name: 'Fade + Lineup',         price_cents: 4500, duration_min: 55 },
]

async function seed() {
  console.log('Seeding demo accounts...')

  for (const u of DEMO_USERS) {
    // Upsert user (partial unique index needs WHERE clause on conflict target)
    const { rows } = await query(
      `INSERT INTO users (name, email, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) WHERE email IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING id`,
      [u.name, u.email, u.role]
    )
    const userId = rows[0].id
    console.log(`  ${u.role.padEnd(8)} ${u.name} <${u.email}> → ${userId}`)

    if (u.role === 'barber') {
      // Upsert barber_profile
      await query(
        `INSERT INTO barber_profiles (user_id, bio, years_experience, is_available)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id) DO UPDATE
           SET bio = EXCLUDED.bio,
               years_experience = EXCLUDED.years_experience,
               is_available = true`,
        [userId, u.bio, u.years_experience]
      )

      // Upsert services — delete existing demo services then re-insert
      await query(`DELETE FROM barber_services WHERE barber_id = $1`, [userId])
      for (const svc of BARBER_SERVICES) {
        await query(
          `INSERT INTO barber_services (barber_id, name, price_cents, duration_min)
           VALUES ($1, $2, $3, $4)`,
          [userId, svc.name, svc.price_cents, svc.duration_min]
        )
      }
    }
  }

  console.log('\nDone. Demo accounts:')
  console.log('  Customers : alex@beam0.demo, jordan@beam0.demo, taylor@beam0.demo')
  console.log('  Barbers   : marcus@beam0.demo, devon@beam0.demo, malik@beam0.demo')
  console.log('  Admin     : admin@beam0.demo')
  console.log('  OTP code  : 000000 (via MASTER_OTP env var)')
  process.exit(0)
}

seed().catch(err => { console.error(err); process.exit(1) })
