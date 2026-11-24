'use strict';

/**
 * Creates the database (if missing) and applies db/schema.sql.
 * WARNING: the schema drops and recreates every table.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

async function main() {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${env.db.database}\``);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await conn.query(schema);
  await conn.end();
  console.log(`✔ Schema applied to database "${env.db.database}"`);
}

main().catch((err) => {
  console.error('✖ Database initialisation failed:', err.message);
  process.exit(1);
});
