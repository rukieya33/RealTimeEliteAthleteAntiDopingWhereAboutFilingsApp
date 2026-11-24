'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const env = require('./src/config/env');
const { pool, query } = require('./src/config/db');
const { requireAuth } = require('./src/middleware/auth');
const { notFound, errorHandler } = require('./src/middleware/errors');
const realtime = require('./src/services/realtime');
const t = require('./src/utils/time');

const { auth, live } = require('./src/routes/core');
const athletes = require('./src/routes/athletes');
const filings = require('./src/routes/filings');
const { locations, travel, competitions, failures } = require('./src/routes/records');

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev', {
  skip: (req) => req.path === '/api/stream',
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---- API ----------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'up', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});
app.use('/api/auth', auth);
app.use('/api', requireAuth, live);
app.use('/api/athletes', requireAuth, athletes);
app.use('/api/filings', requireAuth, filings);
app.use('/api/locations', requireAuth, locations);
app.use('/api/travel', requireAuth, travel);
app.use('/api/competitions', requireAuth, competitions);
app.use('/api/failures', requireAuth, failures);
app.use('/api', notFound);

// ---- Front end ----------------------------------------------------------
app.get('/templates/athletes-import-template.csv', (req, res) => {
  res.download(path.join(__dirname, 'db', 'data', 'athletes-import-template.csv'));
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(errorHandler);

// ---- Live ticker --------------------------------------------------------
// Every LIVE_TICK_SECONDS the server tells browsers the time, and announces
// any 60-minute slots that have just opened or closed and day rollovers.
let last = t.nowParts(env.appTz);
async function tick() {
  const now = t.nowParts(env.appTz);
  try {
    if (now.date !== last.date) {
      realtime.broadcast('day.changed', { date: now.date });
    } else if (now.minutes !== last.minutes) {
      const from = t.minutesToTime(last.minutes + 1);
      const to = t.minutesToTime(now.minutes);
      const rows = await query(
        `SELECT f.athlete_id, f.slot_start, f.slot_end, a.first_name, a.last_name, l.label, l.city
         FROM whereabouts_filings f JOIN athletes a ON a.id = f.athlete_id
         JOIN allowed_locations l ON l.id = f.slot_location_id
         WHERE f.filing_date = ? AND ((f.slot_start BETWEEN ? AND ?) OR (f.slot_end BETWEEN ? AND ?))`,
        [now.date, from, to, from, to]
      );
      for (const r of rows) {
        const started = r.slot_start >= from && r.slot_start <= to;
        realtime.broadcast(started ? 'slot.started' : 'slot.ended', {
          athleteId: r.athlete_id,
          athleteName: `${r.first_name} ${r.last_name}`,
          slot: `${r.slot_start.slice(0, 5)}–${r.slot_end.slice(0, 5)}`,
          location: `${r.label}, ${r.city}`,
        });
      }
    }
    realtime.broadcast('tick', { now, timeZone: env.appTz });
  } catch (err) {
    console.error('Live tick failed:', err.message);
  }
  last = now;
}

const server = app.listen(env.port, () => {
  console.log(`▶ ${env.appName} – whereabouts app running on http://localhost:${env.port} (${env.appTz})`);
});
const ticker = setInterval(tick, env.rules.liveTickSeconds * 1000);

function shutdown() {
  clearInterval(ticker);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
