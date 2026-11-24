'use strict';

const mysql = require('mysql2/promise');
const env = require('./env');

// dateStrings keeps DATE / TIME / DATETIME values as plain strings so that
// whereabouts dates are never shifted by the Node process's time zone.
const pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  timezone: 'Z',
  charset: 'utf8mb4',
});

// Audit / submission timestamps (CURRENT_TIMESTAMP) are stored in UTC.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, transaction };
