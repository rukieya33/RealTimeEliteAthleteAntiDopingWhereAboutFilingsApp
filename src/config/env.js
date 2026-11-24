'use strict';

require('dotenv').config();

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const env = {
  port: int('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  appTz: process.env.APP_TZ || 'Europe/London',
  appName: process.env.APP_NAME || 'Apex Athlete Management',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int('DB_PORT', 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'athlete_whereabouts',
  },
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@agency.test',
    password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!',
  },
  rules: {
    quarterlyDeadlineDay: int('QUARTERLY_DEADLINE_DAY', 15),
    failureWindowMonths: int('FAILURE_WINDOW_MONTHS', 12),
    failureThreshold: int('FAILURE_THRESHOLD', 3),
    liveTickSeconds: int('LIVE_TICK_SECONDS', 30),
  },
};

if (env.nodeEnv === 'production' && env.jwtSecret === 'dev-only-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = env;
