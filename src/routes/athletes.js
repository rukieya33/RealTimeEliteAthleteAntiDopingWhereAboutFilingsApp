'use strict';

const express = require('express');
const env = require('../config/env');
const { query } = require('../config/db');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { canEdit, adminOnly } = require('../middleware/auth');
const compliance = require('../services/compliance');
const realtime = require('../services/realtime');
const audit = require('../services/audit');
const t = require('../utils/time');

const router = express.Router();

const ATHLETE_FIELDS = ['athlete_code', 'first_name', 'last_name', 'gender', 'date_of_birth', 'nationality', 'sport',
  'discipline', 'testing_pool', 'email', 'phone', 'agent_name', 'status', 'notes'];
const LOCATION_FIELDS = ['label', 'location_type', 'address_line', 'city', 'region', 'country', 'postcode', 'access_notes', 'is_active'];

function pickFields(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  }
  return out;
}

function validateAthlete(a, isCreate) {
  const errors = [];
  for (const f of ['first_name', 'last_name', 'nationality', 'sport']) {
    if (isCreate || a[f] !== undefined) if (!a[f] || !String(a[f]).trim()) errors.push(`${f.replace('_', ' ')} is required`);
  }
  if (a.date_of_birth && !t.isValidDate(a.date_of_birth)) errors.push('Date of birth must be YYYY-MM-DD');
  if (a.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) errors.push('Email is not valid');
  if (errors.length) throw new HttpError(422, 'Please correct the athlete details', errors);
}

function validateLocation(l, isCreate) {
  const errors = [];
  for (const f of ['label', 'location_type', 'address_line', 'city', 'country']) {
    if ((isCreate || l[f] !== undefined) && (!l[f] || !String(l[f]).trim())) errors.push(`${f.replace('_', ' ')} is required`);
  }
  if (errors.length) throw new HttpError(422, 'Please correct the location', errors);
}

// GET /api/athletes – list with today's filing status and failure risk
router.get('/', asyncHandler(async (req, res) => {
  const today = t.todayInTz(env.appTz);
  const rows = await query(
    `SELECT a.*,
       (SELECT COUNT(*) FROM allowed_locations l WHERE l.athlete_id = a.id AND l.is_active = 1) AS location_count,
       (SELECT COUNT(*) FROM whereabouts_filings f WHERE f.athlete_id = a.id AND f.filing_date = ?) AS filed_today,
       (SELECT MAX(f.filing_date) FROM whereabouts_filings f WHERE f.athlete_id = a.id) AS filed_until
     FROM athletes a ORDER BY a.last_name, a.first_name`,
    [today]
  );
  const fails = await compliance.failureCounts(today);
  res.json(rows.map((r) => {
    const n = fails.get(r.id) || 0;
    return { ...r, failures: { count: n, ...compliance.riskLevel(n) } };
  }));
}));

// GET /api/athletes/:id – profile with locations, travel, competitions, failures
router.get('/:id', asyncHandler(async (req, res) => {
  const [athlete] = await query('SELECT * FROM athletes WHERE id = ?', [req.params.id]);
  if (!athlete) throw new HttpError(404, 'Athlete not found');
  const today = t.todayInTz(env.appTz);
  const [locations, travel, competitions, failures] = await Promise.all([
    query(`SELECT * FROM allowed_locations WHERE athlete_id = ? ORDER BY is_active DESC,
           FIELD(location_type,'Home','Training','Gym','Medical','Family','Training Camp','Hotel','Competition Venue','Other'), label`, [athlete.id]),
    query('SELECT * FROM travel_bookings WHERE athlete_id = ? ORDER BY depart_at', [athlete.id]),
    query(`SELECT c.*, ce.event_name, ce.entry_status FROM competition_entries ce
           JOIN competitions c ON c.id = ce.competition_id WHERE ce.athlete_id = ? ORDER BY c.start_date`, [athlete.id]),
    query('SELECT * FROM whereabouts_failures WHERE athlete_id = ? ORDER BY incident_date DESC', [athlete.id]),
  ]);
  const counts = await compliance.failureCounts(today);
  const n = counts.get(athlete.id) || 0;
  res.json({ ...athlete, locations, travel, competitions, failures, risk: { count: n, ...compliance.riskLevel(n) } });
}));

router.post('/', canEdit, asyncHandler(async (req, res) => {
  const data = pickFields(req.body, ATHLETE_FIELDS);
  validateAthlete(data, true);
  if (!data.athlete_code) {
    const [{ next }] = await query('SELECT COALESCE(MAX(id),0) + 1001 AS next FROM athletes');
    data.athlete_code = `ATH-${next}`;
  }
  const r = await query('INSERT INTO athletes SET ?', [data]);
  realtime.broadcast('athlete.changed', { athleteId: r.insertId });
  await audit.record(req.user, { action: 'create', entity: 'athlete', entityId: r.insertId, athleteId: r.insertId, summary: `Added athlete ${data.first_name} ${data.last_name}` });
  res.status(201).json({ id: r.insertId, ...data });
}));

router.put('/:id', canEdit, asyncHandler(async (req, res) => {
  const data = pickFields(req.body, ATHLETE_FIELDS);
  validateAthlete(data, false);
  const r = await query('UPDATE athletes SET ? WHERE id = ?', [data, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Athlete not found');
  const [a] = await query('SELECT * FROM athletes WHERE id = ?', [req.params.id]);
  realtime.broadcast('athlete.changed', { athleteId: a.id });
  await audit.record(req.user, { action: 'update', entity: 'athlete', entityId: a.id, athleteId: a.id, summary: `Updated profile of ${a.first_name} ${a.last_name}` });
  res.json(a);
}));

router.delete('/:id', adminOnly, asyncHandler(async (req, res) => {
  const [a] = await query('SELECT * FROM athletes WHERE id = ?', [req.params.id]);
  if (!a) throw new HttpError(404, 'Athlete not found');
  await query('DELETE FROM athletes WHERE id = ?', [a.id]);
  realtime.broadcast('athlete.changed', { athleteId: a.id, deleted: true });
  await audit.record(req.user, { action: 'delete', entity: 'athlete', entityId: a.id, summary: `Removed athlete ${a.first_name} ${a.last_name}` });
  res.status(204).end();
}));

// ---- Allowed locations --------------------------------------------------
router.get('/:id/locations', asyncHandler(async (req, res) => {
  const activeOnly = req.query.active === '1';
  res.json(await query(
    `SELECT * FROM allowed_locations WHERE athlete_id = ? ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY is_active DESC, label`,
    [req.params.id]
  ));
}));

router.post('/:id/locations', canEdit, asyncHandler(async (req, res) => {
  const [a] = await query('SELECT id, first_name, last_name FROM athletes WHERE id = ?', [req.params.id]);
  if (!a) throw new HttpError(404, 'Athlete not found');
  const data = pickFields(req.body, LOCATION_FIELDS);
  validateLocation(data, true);
  const r = await query('INSERT INTO allowed_locations SET ?', [{ ...data, athlete_id: a.id }]);
  realtime.broadcast('location.changed', { athleteId: a.id });
  await audit.record(req.user, { action: 'create', entity: 'location', entityId: r.insertId, athleteId: a.id, summary: `Added allowed location "${data.label}" (${data.city}) for ${a.first_name} ${a.last_name}` });
  res.status(201).json({ id: r.insertId, ...data, athlete_id: a.id });
}));

module.exports = router;
module.exports.LOCATION_FIELDS = LOCATION_FIELDS;
module.exports.pickFields = pickFields;
module.exports.validateLocation = validateLocation;
