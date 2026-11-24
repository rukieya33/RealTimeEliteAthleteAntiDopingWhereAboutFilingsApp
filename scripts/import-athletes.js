'use strict';

/**
 * Usage: npm run import:athletes -- path/to/elite_athletes.csv
 * Adds or updates athletes (matched on athlete_code) and their allowed locations.
 * See src/services/importer.js for the accepted columns.
 */
const fs = require('fs');
const { pool, transaction } = require('../src/config/db');
const { importAthletesCsv } = require('../src/services/importer');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run import:athletes -- <file.csv>');
    process.exit(1);
  }
  const csv = fs.readFileSync(file, 'utf8');
  const result = await transaction((conn) => importAthletesCsv(conn, csv));
  console.log(`✔ Created ${result.created}, updated ${result.updated}, added ${result.locations} allowed locations`);
  result.errors.forEach((e) => console.warn('  ⚠', e));
  await pool.end();
}

main().catch(async (err) => {
  console.error('✖ Import failed:', err.message);
  await pool.end();
  process.exit(1);
});
