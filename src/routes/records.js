'use strict';

/**
 * Routes for allowed locations, travel bookings, competitions and failures.
 */
const express = require('express');
const env = require('../config/env');
const { query } = require('../config/db');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { canEdit } = require('../middleware/auth');
const realtime = require('../services/realtime');
const audit = require('../services/audit');
const t = require('../utils/time');
const { LOCATION_FIELDS, pickFields, validateLocation } = require('./athletes');

// ===================== Allowed locations =================================
const locations = express.Router();

locations.put('/:id', canEdit, asyncHandler(async (req, res) => {
  const [loc] = await query('SELECT * FROM allowed_locations WHERE id = ?', [req.params.id]);
  if (!loc) throw new HttpError(404, 'Location not found');
  const data = pickFields(req.body, LOCATION_FIELDS);
  validateLocation(data, false);
  await query('UPDATE allowed_locations SET ? WHERE id = ?', [data, loc.id]);
  realtime.broadcast('location.changed', { athleteId: loc.athlete_id });
  await audit.record(req.user, { action: 'update', entity: 'location', entityId: loc.id, athleteId: loc.athlete_id, summary: `Updated allowed location "${data.label || loc.label}"` });
  res.json({ ...loc, ...data });
}));

// Locations used by filings are deactivated rather than deleted to keep history intact.
locations.delete('/:id', canEdit, asyncHandler(async (req, res) => {
  const [loc] = await query('SELECT * FROM allowed_locations WHERE id = ?', [req.params.id]);
  if (!loc) throw new HttpError(404, 'Location not found');
  const [{ n }] = await query(
    `SELECT (SELECT COUNT(*) FROM whereabouts_filings WHERE overnight_location_id = ? OR slot_location_id = ?)
          + (SELECT COUNT(*) FROM filing_activities WHERE location_id = ?) AS n`,
    [loc.id, loc.id, loc.id]
  );
  let result;
  if (Number(n) > 0) {
    await query('UPDATE allowed_locations SET is_active = 0 WHERE id = ?', [loc.id]);
    result = { deactivated: true, message: `"${loc.label}" is used in ${n} filing entries, so it was deactivated instead of deleted.` };
  } else {
    await query('DELETE FROM allowed_locations WHERE id = ?', [loc.id]);
    result = { deleted: true };
  }
  realtime.broadcast('location.changed', { athleteId: loc.athlete_id });
  await audit.record(req.user, { action: result.deleted ? 'delete' : 'deactivate', entity: 'location', entityId: loc.id, athleteId: loc.athlete_id, summary: `${result.deleted ? 'Removed' : 'Deactivated'} allowed location "${loc.label}"` });
  res.json(result);
}));

// ===================== Travel bookings ====================================
const travel = express.Router();
const TRAVEL_FIELDS = ['athlete_id', 'competition_id', 'booking_ref', 'travel_type', 'carrier', 'travel_booking_location',
  'origin', 'destination_city', 'depart_at', 'arrive_at', 'accommodation', 'status'];
const DT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

function validateTravel(d, isCreate) {
  const errors = [];
  for (const f of ['athlete_id', 'travel_type', 'travel_booking_location', 'origin', 'depart_at', 'arrive_at']) {
    if ((isCreate || d[f] !== undefined) && !d[f]) errors.push(`${f.replace(/_/g, ' ')} is required`);
  }
  for (const f of ['depart_at', 'arrive_at']) {
    if (d[f] && !DT_RE.test(d[f])) errors.push(`${f.replace('_', ' ')} must be a date and time`);
    if (d[f]) d[f] = d[f].replace('T', ' ');
  }
  if (d.depart_at && d.arrive_at && d.arrive_at < d.depart_at) errors.push('Arrival must be after departure');
  if (d.travel_booking_location && !d.destination_city) d.destination_city = d.travel_booking_location.split(',')[0].trim();
  if (errors.length) throw new HttpError(422, 'Please correct the travel booking', errors);
}

travel.get('/', asyncHandler(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.athlete_id) { where.push('b.athlete_id = ?'); params.push(req.query.athlete_id); }
  if (req.query.upcoming === '1') { where.push('b.arrive_at >= ?'); params.push(`${t.todayInTz(env.appTz)} 00:00:00`); }
  res.json(await query(
    `SELECT b.*, a.first_name, a.last_name, a.athlete_code, c.name AS competition_name
     FROM travel_bookings b JOIN athletes a ON a.id = b.athlete_id
     LEFT JOIN competitions c ON c.id = b.competition_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.depart_at`, params
  ));
}));

travel.post('/', canEdit, asyncHandler(async (req, res) => {
  const d = pickFields(req.body, TRAVEL_FIELDS);
  validateTravel(d, true);
  if (!d.booking_ref) d.booking_ref = `TB-${Date.now().toString().slice(-6)}`;
  const r = await query('INSERT INTO travel_bookings SET ?', [d]);
  realtime.broadcast('travel.changed', { athleteId: Number(d.athlete_id) });
  await audit.record(req.user, { action: 'create', entity: 'travel', entityId: r.insertId, athleteId: Number(d.athlete_id), summary: `Booked ${d.travel_type} ${d.booking_ref} to ${d.travel_booking_location}` });
  res.status(201).json({ id: r.insertId, ...d });
}));

travel.put('/:id', canEdit, asyncHandler(async (req, res) => {
  const [b] = await query('SELECT * FROM travel_bookings WHERE id = ?', [req.params.id]);
  if (!b) throw new HttpError(404, 'Booking not found');
  const d = pickFields(req.body, TRAVEL_FIELDS);
  validateTravel(d, false);
  await query('UPDATE travel_bookings SET ? WHERE id = ?', [d, b.id]);
  realtime.broadcast('travel.changed', { athleteId: b.athlete_id });
  await audit.record(req.user, { action: 'update', entity: 'travel', entityId: b.id, athleteId: b.athlete_id, summary: `Updated travel booking ${b.booking_ref}${d.status ? ` (${d.status})` : ''}` });
  res.json({ ...b, ...d });
}));

travel.delete('/:id', canEdit, asyncHandler(async (req, res) => {
  const [b] = await query('SELECT * FROM travel_bookings WHERE id = ?', [req.params.id]);
  if (!b) throw new HttpError(404, 'Booking not found');
  await query('DELETE FROM travel_bookings WHERE id = ?', [b.id]);
  realtime.broadcast('travel.changed', { athleteId: b.athlete_id });
  await audit.record(req.user, { action: 'delete', entity: 'travel', entityId: b.id, athleteId: b.athlete_id, summary: `Deleted travel booking ${b.booking_ref}` });
  res.status(204).end();
}));

// ===================== Competitions =======================================
const competitions = express.Router();
const COMP_FIELDS = ['name', 'sport', 'level', 'venue', 'competition_location', 'city', 'country', 'start_date', 'end_date'];

function validateComp(d, isCreate) {
  const errors = [];
  for (const f of ['name', 'sport', 'venue', 'city', 'country', 'start_date', 'end_date']) {
    if ((isCreate || d[f] !== undefined) && !d[f]) errors.push(`${f.replace('_', ' ')} is required`);
  }
  if (d.start_date && !t.isValidDate(d.start_date)) errors.push('Start date must be YYYY-MM-DD');
  if (d.end_date && !t.isValidDate(d.end_date)) errors.push('End date must be YYYY-MM-DD');
  if (d.start_date && d.end_date && d.end_date < d.start_date) errors.push('End date must be on or after the start date');
  if (d.city && d.country) d.competition_location = `${d.city}, ${d.country}`;
  if (errors.length) throw new HttpError(422, 'Please correct the competition', errors);
}

competitions.get('/', asyncHandler(async (req, res) => {
  const where = req.query.upcoming === '1' ? 'WHERE c.end_date >= ?' : '';
  const comps = await query(`SELECT c.* FROM competitions c ${where} ORDER BY c.start_date`, where ? [t.todayInTz(env.appTz)] : []);
  const entries = await query(
    `SELECT ce.*, a.first_name, a.last_name, a.athlete_code FROM competition_entries ce
     JOIN athletes a ON a.id = ce.athlete_id ORDER BY a.last_name`
  );
  res.json(comps.map((c) => ({ ...c, entries: entries.filter((e) => e.competition_id === c.id) })));
}));

competitions.post('/', canEdit, asyncHandler(async (req, res) => {
  const d = pickFields(req.body, COMP_FIELDS);
  validateComp(d, true);
  const r = await query('INSERT INTO competitions SET ?', [d]);
  realtime.broadcast('competition.changed', { competitionId: r.insertId });
  await audit.record(req.user, { action: 'create', entity: 'competition', entityId: r.insertId, summary: `Added competition ${d.name} (${d.competition_location})` });
  res.status(201).json({ id: r.insertId, ...d });
}));

competitions.put('/:id', canEdit, asyncHandler(async (req, res) => {
  const [c] = await query('SELECT * FROM competitions WHERE id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Competition not found');
  const d = pickFields(req.body, COMP_FIELDS);
  validateComp({ ...c, ...d }, false);
  if (d.city || d.country) d.competition_location = `${d.city || c.city}, ${d.country || c.country}`;
  await query('UPDATE competitions SET ? WHERE id = ?', [d, c.id]);
  realtime.broadcast('competition.changed', { competitionId: c.id });
  await audit.record(req.user, { action: 'update', entity: 'competition', entityId: c.id, summary: `Updated competition ${d.name || c.name}` });
  res.json({ ...c, ...d });
}));

competitions.delete('/:id', canEdit, asyncHandler(async (req, res) => {
  const [c] = await query('SELECT * FROM competitions WHERE id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Competition not found');
  await query('DELETE FROM competitions WHERE id = ?', [c.id]);
  realtime.broadcast('competition.changed', { competitionId: c.id });
  await audit.record(req.user, { action: 'delete', entity: 'competition', entityId: c.id, summary: `Deleted competition ${c.name}` });
  res.status(204).end();
}));

competitions.post('/:id/entries', canEdit, asyncHandler(async (req, res) => {
  const [c] = await query('SELECT * FROM competitions WHERE id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Competition not found');
  const athleteId = Number(req.body.athlete_id);
  const [a] = await query('SELECT * FROM athletes WHERE id = ?', [athleteId]);
  if (!a) throw new HttpError(422, 'Choose an athlete');
  const r = await query('INSERT INTO competition_entries SET ?', [{ competition_id: c.id, athlete_id: athleteId, event_name: req.body.event_name || null, entry_status: req.body.entry_status || 'Confirmed' }]);
  realtime.broadcast('competition.changed', { competitionId: c.id, athleteId });
  await audit.record(req.user, { action: 'create', entity: 'entry', entityId: r.insertId, athleteId, summary: `Entered ${a.first_name} ${a.last_name} in ${c.name}` });
  res.status(201).json({ id: r.insertId });
}));

competitions.delete('/:id/entries/:athleteId', canEdit, asyncHandler(async (req, res) => {
  await query('DELETE FROM competition_entries WHERE competition_id = ? AND athlete_id = ?', [req.params.id, req.params.athleteId]);
  realtime.broadcast('competition.changed', { competitionId: Number(req.params.id), athleteId: Number(req.params.athleteId) });
  await audit.record(req.user, { action: 'delete', entity: 'entry', athleteId: Number(req.params.athleteId), summary: 'Removed a competition entry' });
  res.status(204).end();
}));

// ===================== Whereabouts failures ===============================
const failures = express.Router();

failures.get('/', asyncHandler(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.athlete_id) { where = 'WHERE w.athlete_id = ?'; params.push(req.query.athlete_id); }
  res.json(await query(
    `SELECT w.*, a.first_name, a.last_name, a.athlete_code FROM whereabouts_failures w
     JOIN athletes a ON a.id = w.athlete_id ${where} ORDER BY w.incident_date DESC`, params
  ));
}));

failures.post('/', canEdit, asyncHandler(async (req, res) => {
  const d = pickFields(req.body, ['athlete_id', 'failure_type', 'incident_date', 'description', 'status']);
  const errors = [];
  if (!d.athlete_id) errors.push('Athlete is required');
  if (!['Filing Failure', 'Missed Test'].includes(d.failure_type)) errors.push('Choose a failure type');
  if (!t.isValidDate(d.incident_date)) errors.push('Incident date is required');
  if (errors.length) throw new HttpError(422, 'Please correct the failure record', errors);
  const [a] = await query('SELECT first_name, last_name FROM athletes WHERE id = ?', [d.athlete_id]);
  if (!a) throw new HttpError(422, 'Athlete not found');
  const r = await query('INSERT INTO whereabouts_failures SET ?', [d]);
  realtime.broadcast('failure.changed', { athleteId: Number(d.athlete_id) });
  await audit.record(req.user, { action: 'create', entity: 'failure', entityId: r.insertId, athleteId: Number(d.athlete_id), summary: `Recorded ${d.failure_type} for ${a.first_name} ${a.last_name} (${d.incident_date})` });
  res.status(201).json({ id: r.insertId, ...d });
}));

failures.put('/:id', canEdit, asyncHandler(async (req, res) => {
  const [f] = await query('SELECT * FROM whereabouts_failures WHERE id = ?', [req.params.id]);
  if (!f) throw new HttpError(404, 'Failure record not found');
  const d = pickFields(req.body, ['failure_type', 'incident_date', 'description', 'status']);
  await query('UPDATE whereabouts_failures SET ? WHERE id = ?', [d, f.id]);
  realtime.broadcast('failure.changed', { athleteId: f.athlete_id });
  await audit.record(req.user, { action: 'update', entity: 'failure', entityId: f.id, athleteId: f.athlete_id, summary: `Failure record #${f.id} set to ${d.status || f.status}` });
  res.json({ ...f, ...d });
}));

module.exports = { locations, travel, competitions, failures };
