'use strict';

const express = require('express');
const env = require('../config/env');
const { query, transaction } = require('../config/db');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { canEdit } = require('../middleware/auth');
const compliance = require('../services/compliance');
const realtime = require('../services/realtime');
const audit = require('../services/audit');
const t = require('../utils/time');

const router = express.Router();
const ACTIVITY_TYPES = ['Training', 'Competition', 'Gym', 'Medical', 'Work', 'Study', 'Travel', 'Other'];

async function athleteName(id) {
  const [a] = await query('SELECT first_name, last_name FROM athletes WHERE id = ?', [id]);
  if (!a) throw new HttpError(404, 'Athlete not found');
  return `${a.first_name} ${a.last_name}`;
}

/** Validates a filing payload; every location must be one of the athlete's active allowed locations. */
async function validateFiling(body, athleteId) {
  const errors = [];
  const date = body.filing_date;
  if (!t.isValidDate(date)) errors.push('A valid filing date (YYYY-MM-DD) is required');
  const slotErr = compliance.validateSlot(body.slot_start);
  if (slotErr) errors.push(slotErr);

  const locs = await query('SELECT id FROM allowed_locations WHERE athlete_id = ? AND is_active = 1', [athleteId]);
  const allowed = new Set(locs.map((l) => l.id));
  const overnight = Number(body.overnight_location_id);
  const slotLoc = Number(body.slot_location_id);
  if (!allowed.has(overnight)) errors.push('Overnight location must be one of the athlete\'s allowed locations');
  if (!allowed.has(slotLoc)) errors.push('60-minute slot location must be one of the athlete\'s allowed locations');

  const activities = Array.isArray(body.activities) ? body.activities : [];
  activities.forEach((a, i) => {
    const n = i + 1;
    if (!ACTIVITY_TYPES.includes(a.activity_type)) errors.push(`Activity ${n}: choose a valid activity type`);
    if (!allowed.has(Number(a.location_id))) errors.push(`Activity ${n}: location must be an allowed location`);
    if (!t.isValidTime(a.start_time) || !t.isValidTime(a.end_time)) errors.push(`Activity ${n}: start and end times are required`);
    else if (t.timeToMinutes(a.end_time) <= t.timeToMinutes(a.start_time)) errors.push(`Activity ${n}: end time must be after start time`);
  });
  if (errors.length) throw new HttpError(422, 'Please correct the filing', errors);

  const startMin = t.timeToMinutes(body.slot_start);
  return {
    filing: {
      athlete_id: athleteId,
      filing_date: date,
      overnight_location_id: overnight,
      slot_start: t.minutesToTime(startMin),
      slot_end: t.minutesToTime(startMin + 60),
      slot_location_id: slotLoc,
      notes: body.notes ? String(body.notes).slice(0, 255) : null,
    },
    activities: activities.map((a) => ({
      activity_type: a.activity_type,
      location_id: Number(a.location_id),
      start_time: a.start_time,
      end_time: a.end_time,
      description: a.description ? String(a.description).slice(0, 190) : null,
    })),
  };
}

async function writeActivities(conn, filingId, activities) {
  await conn.query('DELETE FROM filing_activities WHERE filing_id = ?', [filingId]);
  if (activities.length) {
    await conn.query(
      'INSERT INTO filing_activities (filing_id, activity_type, location_id, start_time, end_time, description) VALUES ?',
      [activities.map((a) => [filingId, a.activity_type, a.location_id, a.start_time, a.end_time, a.description])]
    );
  }
}

async function boardEntry(athleteId, date) {
  const board = await compliance.getBoard({ date, athleteId });
  return board.athletes[0];
}

/** A filing changed today counts as a same-day update; earlier changes are quarterly filings. */
function sourceFor(date) {
  return date <= t.addDays(t.todayInTz(env.appTz), 1) ? 'Update' : 'Quarterly';
}

// GET /api/filings?athlete_id=&from=&to=
router.get('/', asyncHandler(async (req, res) => {
  const { athlete_id: athleteId } = req.query;
  const today = t.todayInTz(env.appTz);
  const from = t.isValidDate(req.query.from) ? req.query.from : t.addDays(today, -7);
  const to = t.isValidDate(req.query.to) ? req.query.to : t.addDays(today, 30);
  if (!athleteId) throw new HttpError(400, 'athlete_id is required');

  const filings = await query(
    `SELECT f.id, f.filing_date, f.slot_start, f.slot_end, f.notes, f.source, f.version, f.updated_at,
            f.overnight_location_id, f.slot_location_id,
            o.label AS overnight_label, o.city AS overnight_city,
            s.label AS slot_label, s.city AS slot_city
     FROM whereabouts_filings f
     JOIN allowed_locations o ON o.id = f.overnight_location_id
     JOIN allowed_locations s ON s.id = f.slot_location_id
     WHERE f.athlete_id = ? AND f.filing_date BETWEEN ? AND ?
     ORDER BY f.filing_date`,
    [athleteId, from, to]
  );
  const ids = filings.map((f) => f.id);
  const acts = ids.length
    ? await query(
      `SELECT fa.*, l.label AS location_label, l.city AS location_city
       FROM filing_activities fa JOIN allowed_locations l ON l.id = fa.location_id
       WHERE fa.filing_id IN (?) ORDER BY fa.start_time`, [ids])
    : [];
  const byFiling = new Map();
  acts.forEach((a) => {
    if (!byFiling.has(a.filing_id)) byFiling.set(a.filing_id, []);
    byFiling.get(a.filing_id).push(a);
  });
  res.json({ from, to, filings: filings.map((f) => ({ ...f, activities: byFiling.get(f.id) || [] })) });
}));

// GET /api/filings/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const [f] = await query('SELECT * FROM whereabouts_filings WHERE id = ?', [req.params.id]);
  if (!f) throw new HttpError(404, 'Filing not found');
  f.activities = await query('SELECT * FROM filing_activities WHERE filing_id = ? ORDER BY start_time', [f.id]);
  res.json(f);
}));

// POST /api/filings  – create a day's whereabouts
router.post('/', canEdit, asyncHandler(async (req, res) => {
  const athleteId = Number(req.body.athlete_id);
  const name = await athleteName(athleteId);
  const { filing, activities } = await validateFiling(req.body, athleteId);
  filing.source = sourceFor(filing.filing_date);
  filing.submitted_by = req.user.id;

  const id = await transaction(async (conn) => {
    const [exists] = await conn.query('SELECT id FROM whereabouts_filings WHERE athlete_id = ? AND filing_date = ?', [athleteId, filing.filing_date]);
    if (exists.length) throw new HttpError(409, `A filing already exists for ${name} on ${filing.filing_date}. Edit it instead.`);
    const [r] = await conn.query('INSERT INTO whereabouts_filings SET ?', [filing]);
    await writeActivities(conn, r.insertId, activities);
    return r.insertId;
  });

  const entry = await boardEntry(athleteId, filing.filing_date);
  realtime.broadcast('filing.created', { athleteId, date: filing.filing_date, filingId: id, athleteName: name, by: req.user.name });
  await audit.record(req.user, { action: 'create', entity: 'filing', entityId: id, athleteId, summary: `Filed whereabouts for ${name} on ${filing.filing_date} (slot ${filing.slot_start.slice(0, 5)})` });
  res.status(201).json({ id, entry, warnings: entry.conflicts });
}));

// POST /api/filings/bulk – apply one day template to a range of dates (quarterly filing helper)
router.post('/bulk', canEdit, asyncHandler(async (req, res) => {
  const athleteId = Number(req.body.athlete_id);
  const name = await athleteName(athleteId);
  const { from, to, weekdays, overwrite } = req.body;
  if (!t.isValidDate(from) || !t.isValidDate(to) || to < from) throw new HttpError(422, 'Choose a valid date range');
  if (t.diffDays(to, from) > 120) throw new HttpError(422, 'A bulk filing can cover at most 120 days');
  const days = Array.isArray(weekdays) && weekdays.length ? weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  const { filing, activities } = await validateFiling({ ...req.body, filing_date: from }, athleteId);

  const result = await transaction(async (conn) => {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (let d = from; d <= to; d = t.addDays(d, 1)) {
      if (!days.includes(t.dayOfWeek(d))) continue;
      const [exists] = await conn.query('SELECT id FROM whereabouts_filings WHERE athlete_id = ? AND filing_date = ?', [athleteId, d]);
      const row = { ...filing, filing_date: d, submitted_by: req.user.id, source: 'Quarterly' };
      if (exists.length) {
        if (!overwrite) { skipped += 1; continue; }
        await conn.query('UPDATE whereabouts_filings SET ?, version = version + 1 WHERE id = ?', [row, exists[0].id]);
        await writeActivities(conn, exists[0].id, activities);
        updated += 1;
      } else {
        const [r] = await conn.query('INSERT INTO whereabouts_filings SET ?', [row]);
        await writeActivities(conn, r.insertId, activities);
        created += 1;
      }
    }
    return { created, updated, skipped };
  });

  realtime.broadcast('filing.bulk', { athleteId, from, to, ...result, athleteName: name, by: req.user.name });
  await audit.record(req.user, { action: 'bulk', entity: 'filing', athleteId, summary: `Bulk filing for ${name} ${from} → ${to}: ${result.created} new, ${result.updated} updated` });
  res.json(result);
}));

// PUT /api/filings/:id – same-day or advance update
router.put('/:id', canEdit, asyncHandler(async (req, res) => {
  const [current] = await query('SELECT * FROM whereabouts_filings WHERE id = ?', [req.params.id]);
  if (!current) throw new HttpError(404, 'Filing not found');
  const name = await athleteName(current.athlete_id);
  const { filing, activities } = await validateFiling({ ...req.body, filing_date: current.filing_date }, current.athlete_id);

  const today = t.todayInTz(env.appTz);
  if (current.filing_date < today && req.user.role !== 'admin') {
    throw new HttpError(403, 'Past filings can only be corrected by an administrator');
  }

  await transaction(async (conn) => {
    await conn.query(
      'UPDATE whereabouts_filings SET ?, version = version + 1, source = ?, submitted_by = ? WHERE id = ?',
      [{ overnight_location_id: filing.overnight_location_id, slot_start: filing.slot_start, slot_end: filing.slot_end, slot_location_id: filing.slot_location_id, notes: filing.notes },
        sourceFor(current.filing_date), req.user.id, current.id]
    );
    await writeActivities(conn, current.id, activities);
  });

  const entry = await boardEntry(current.athlete_id, current.filing_date);
  const changedSlot = current.slot_start.slice(0, 5) !== filing.slot_start.slice(0, 5) || current.slot_location_id !== filing.slot_location_id;
  realtime.broadcast('filing.updated', { athleteId: current.athlete_id, date: current.filing_date, filingId: current.id, athleteName: name, by: req.user.name, slotChanged: changedSlot });
  await audit.record(req.user, {
    action: 'update', entity: 'filing', entityId: current.id, athleteId: current.athlete_id,
    summary: `Updated whereabouts for ${name} on ${current.filing_date}${changedSlot ? ` – slot now ${filing.slot_start.slice(0, 5)} at ${entry.filing.slot.label}` : ''}`,
  });
  res.json({ id: current.id, entry, warnings: entry.conflicts });
}));

// DELETE /api/filings/:id – only future filings
router.delete('/:id', canEdit, asyncHandler(async (req, res) => {
  const [f] = await query('SELECT * FROM whereabouts_filings WHERE id = ?', [req.params.id]);
  if (!f) throw new HttpError(404, 'Filing not found');
  if (f.filing_date <= t.todayInTz(env.appTz)) throw new HttpError(422, 'Only future filings can be withdrawn. Update today\'s filing instead.');
  const name = await athleteName(f.athlete_id);
  await query('DELETE FROM whereabouts_filings WHERE id = ?', [f.id]);
  realtime.broadcast('filing.deleted', { athleteId: f.athlete_id, date: f.filing_date, filingId: f.id, athleteName: name, by: req.user.name });
  await audit.record(req.user, { action: 'delete', entity: 'filing', entityId: f.id, athleteId: f.athlete_id, summary: `Withdrew filing for ${name} on ${f.filing_date}` });
  res.status(204).end();
}));

module.exports = router;
