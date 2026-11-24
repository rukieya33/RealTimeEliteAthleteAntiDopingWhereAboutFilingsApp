'use strict';

/**
 * Auth, live whereabouts board, dashboard, activity feed, event stream and import.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { query, transaction } = require('../config/db');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { COOKIE, signToken, setAuthCookie, requireAuth, adminOnly } = require('../middleware/auth');
const compliance = require('../services/compliance');
const realtime = require('../services/realtime');
const audit = require('../services/audit');
const { importAthletesCsv } = require('../services/importer');
const t = require('../utils/time');

// ===================== Auth ===============================================
const auth = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

auth.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const [user] = await query('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase().trim()]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  await query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
  setAuthCookie(res, signToken(user));
  res.json({ id: user.id, name: user.full_name, email: user.email, role: user.role });
}));

auth.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

auth.get('/me', requireAuth, (req, res) => res.json(req.user));

// ===================== Live board & dashboard ==============================
const live = express.Router();

live.get('/meta', (req, res) => {
  res.json({
    appName: env.appName, timeZone: env.appTz, now: t.nowParts(env.appTz), rules: env.rules,
    connectedClients: realtime.clientCount(),
  });
});

live.get('/whereabouts/live', asyncHandler(async (req, res) => {
  const date = t.isValidDate(req.query.date) ? req.query.date : undefined;
  res.json(await compliance.getBoard({ date }));
}));

live.get('/whereabouts/coverage', asyncHandler(async (req, res) => {
  res.json(await compliance.getCoverage(req.query.quarter === 'next' ? 'next' : 'current'));
}));

live.get('/dashboard', asyncHandler(async (req, res) => {
  const today = t.todayInTz(env.appTz);
  const [board, current, next, comps, travel, failures, activity] = await Promise.all([
    compliance.getBoard(),
    compliance.getCoverage('current'),
    compliance.getCoverage('next'),
    query(`SELECT c.*, (SELECT COUNT(*) FROM competition_entries ce WHERE ce.competition_id = c.id AND ce.entry_status <> 'Withdrawn') AS entrants
           FROM competitions c WHERE c.end_date >= ? AND c.start_date <= ? ORDER BY c.start_date LIMIT 8`, [today, t.addDays(today, 30)]),
    query(`SELECT b.*, a.first_name, a.last_name FROM travel_bookings b JOIN athletes a ON a.id = b.athlete_id
           WHERE b.status <> 'Cancelled' AND b.depart_at BETWEEN ? AND ? ORDER BY b.depart_at LIMIT 8`,
    [`${today} 00:00:00`, `${t.addDays(today, 7)} 23:59:59`]),
    query(`SELECT w.*, a.first_name, a.last_name FROM whereabouts_failures w JOIN athletes a ON a.id = w.athlete_id
           WHERE w.status <> 'Dismissed' AND w.incident_date > ? ORDER BY w.incident_date DESC`, [t.addMonths(today, -env.rules.failureWindowMonths)]),
    query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 15'),
  ]);
  const strip = (c) => ({ ...c, athletes: c.athletes.map(({ days, ...rest }) => rest) });
  res.json({
    today, serverNow: board.serverNow, timeZone: env.appTz, board: board.summary,
    alerts: board.athletes.filter((a) => !a.filing || a.conflicts.length || a.live.slotState === 'active'),
    coverage: { current: strip(current), next: strip(next) },
    competitions: comps, travel, failures, activity,
    atRisk: board.athletes.filter((a) => a.failures.level !== 'ok').map((a) => ({ athlete: a.athlete, failures: a.failures })),
  });
}));

live.get('/activity', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const params = [];
  let where = '';
  if (req.query.athlete_id) { where = 'WHERE athlete_id = ?'; params.push(req.query.athlete_id); }
  params.push(limit);
  res.json(await query(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`, params));
}));

live.get('/stream', (req, res) => realtime.addClient(req, res));

// ===================== CSV import ========================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

live.post('/import/athletes', adminOnly, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a CSV file to import');
  const result = await transaction((conn) => importAthletesCsv(conn, req.file.buffer.toString('utf8')));
  realtime.broadcast('athlete.changed', { imported: true });
  await audit.record(req.user, { action: 'import', entity: 'athlete', summary: `Imported athletes: ${result.created} new, ${result.updated} updated, ${result.locations} locations` });
  res.json(result);
}));

module.exports = { auth, live };
