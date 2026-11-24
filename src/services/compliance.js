'use strict';

/**
 * Compliance engine: works out, for any day, where each athlete is expected
 * to be, whether they are inside their 60-minute testing slot right now,
 * which filings conflict with travel or competition plans, how complete each
 * quarter's filing is, and each athlete's whereabouts-failure risk.
 */
const env = require('../config/env');
const { query } = require('../config/db');
const t = require('../utils/time');

const SLOT_EARLIEST = 5 * 60;   // 05:00
const SLOT_LATEST_END = 23 * 60; // 23:00

const LOC_COLS = (alias, p) =>
  `${alias}.id AS ${p}_id, ${alias}.label AS ${p}_label, ${alias}.location_type AS ${p}_type, ` +
  `${alias}.address_line AS ${p}_address, ${alias}.city AS ${p}_city, ${alias}.country AS ${p}_country, ` +
  `${alias}.access_notes AS ${p}_access`;

function pickLoc(row, p) {
  if (!row[`${p}_id`]) return null;
  return {
    id: row[`${p}_id`], label: row[`${p}_label`], type: row[`${p}_type`],
    address: row[`${p}_address`], city: row[`${p}_city`], country: row[`${p}_country`],
    access: row[`${p}_access`],
  };
}

function riskLevel(count) {
  const max = env.rules.failureThreshold;
  if (count >= max) return { level: 'critical', label: `${count}/${max} – potential rule violation` };
  if (count === max - 1) return { level: 'high', label: `${count}/${max} – high risk` };
  if (count > 0) return { level: 'warning', label: `${count}/${max} – monitor` };
  return { level: 'ok', label: `0/${max} – clear` };
}

async function failureCounts(asOf) {
  const since = t.addMonths(asOf, -env.rules.failureWindowMonths);
  const rows = await query(
    `SELECT athlete_id, COUNT(*) AS n FROM whereabouts_failures
     WHERE status <> 'Dismissed' AND incident_date > ? AND incident_date <= ?
     GROUP BY athlete_id`,
    [since, asOf]
  );
  return new Map(rows.map((r) => [r.athlete_id, Number(r.n)]));
}

/**
 * Cross-checks filings against competition entries and travel bookings for one day.
 * @param {number[]} athleteIds
 * @param {string} date
 * @param {Map<number,{overnight:object, slot:object, activities:object[]}>} filingsByAthlete
 */
async function conflictsFor(athleteIds, date, filingsByAthlete) {
  const out = new Map(athleteIds.map((id) => [id, []]));
  if (!athleteIds.length) return out;

  const comps = await query(
    `SELECT ce.athlete_id, c.name, c.city, c.country, c.venue
     FROM competition_entries ce JOIN competitions c ON c.id = ce.competition_id
     WHERE ce.entry_status <> 'Withdrawn' AND ? BETWEEN c.start_date AND c.end_date AND ce.athlete_id IN (?)`,
    [date, athleteIds]
  );
  for (const c of comps) {
    const f = filingsByAthlete.get(c.athlete_id);
    if (!f) {
      out.get(c.athlete_id).push({ severity: 'high', message: `Competing at ${c.name} (${c.city}) but no filing for this day` });
      continue;
    }
    const cities = [f.overnight, f.slot, ...f.activities.map((a) => a.location)].filter(Boolean).map((l) => l.city);
    if (!cities.includes(c.city)) {
      out.get(c.athlete_id).push({ severity: 'high', message: `Entered in ${c.name} in ${c.city}, but filing places athlete in ${f.slot.city}` });
    }
  }

  const travel = await query(
    `SELECT athlete_id, booking_ref, travel_type, destination_city, travel_booking_location, depart_at, arrive_at
     FROM travel_bookings
     WHERE status <> 'Cancelled' AND athlete_id IN (?) AND DATE(arrive_at) = ?`,
    [athleteIds, date]
  );
  for (const b of travel) {
    const f = filingsByAthlete.get(b.athlete_id);
    if (f && f.overnight && f.overnight.city !== b.destination_city) {
      out.get(b.athlete_id).push({
        severity: 'medium',
        message: `${b.travel_type} ${b.booking_ref} arrives in ${b.travel_booking_location}, but overnight address is in ${f.overnight.city}`,
      });
    }
  }

  const departures = await query(
    `SELECT athlete_id, booking_ref, travel_type, origin, depart_at
     FROM travel_bookings
     WHERE status <> 'Cancelled' AND athlete_id IN (?) AND DATE(depart_at) = ?`,
    [athleteIds, date]
  );
  for (const b of departures) {
    const f = filingsByAthlete.get(b.athlete_id);
    if (!f) continue;
    const departMin = t.timeToMinutes(b.depart_at.slice(11, 16));
    const slotEnd = t.timeToMinutes(f.slotEnd);
    const slotStart = t.timeToMinutes(f.slotStart);
    if (departMin >= slotStart - 60 && departMin <= slotEnd + 60 && f.slot.city === b.origin.split(',')[0]) {
      out.get(b.athlete_id).push({
        severity: 'medium',
        message: `${b.travel_type} ${b.booking_ref} departs ${b.depart_at.slice(11, 16)} — close to the 60-minute slot`,
      });
    }
  }
  return out;
}

/** Live state of the 60-minute slot and expected location for one filing. */
function liveState(filing, date, now) {
  if (!filing) return { slotState: 'none', expected: null, expectedReason: 'No whereabouts filed' };
  const start = t.timeToMinutes(filing.slotStart);
  const end = t.timeToMinutes(filing.slotEnd);

  if (date < now.date) return { slotState: 'completed', expected: filing.overnight, expectedReason: 'Day complete' };
  if (date > now.date) {
    return { slotState: 'upcoming', expected: filing.slot, expectedReason: 'Future filing', minutesToSlot: t.diffDays(date, now.date) * 1440 + start - now.minutes };
  }

  const m = now.minutes;
  const nowSec = now.seconds;
  let slotState;
  let extra = {};
  if (m < start) {
    slotState = 'upcoming';
    extra = { secondsToSlot: start * 60 - nowSec };
  } else if (m < end) {
    slotState = 'active';
    extra = { secondsRemaining: end * 60 - nowSec };
  } else {
    slotState = 'completed';
  }

  if (slotState === 'active') {
    return { slotState, expected: filing.slot, expectedReason: 'Inside 60-minute testing slot', ...extra };
  }
  const act = filing.activities.find((a) => m >= t.timeToMinutes(a.start) && m < t.timeToMinutes(a.end));
  if (act) return { slotState, expected: act.location, expectedReason: `${act.type}: ${act.description || 'declared activity'}`, ...extra };
  if (m < SLOT_EARLIEST || m >= SLOT_LATEST_END) {
    return { slotState, expected: filing.overnight, expectedReason: 'Overnight address', ...extra };
  }
  return { slotState, expected: null, expectedReason: 'No activity declared for this time', fallback: filing.overnight, ...extra };
}

/**
 * The real-time whereabouts board for a date (default today in APP_TZ).
 */
async function getBoard({ date, athleteId } = {}) {
  const now = t.nowParts(env.appTz);
  const day = date || now.date;
  const params = [day];
  let where = "a.status <> 'Retired'";
  if (athleteId) {
    where += ' AND a.id = ?';
    params.push(athleteId);
  }

  const rows = await query(
    `SELECT a.id AS athlete_id, a.athlete_code, a.first_name, a.last_name, a.sport, a.discipline,
            a.nationality, a.testing_pool, a.status AS athlete_status,
            f.id AS filing_id, f.slot_start, f.slot_end, f.notes, f.source, f.version,
            f.submitted_at, f.updated_at,
            ${LOC_COLS('o', 'o')}, ${LOC_COLS('s', 's')}
     FROM athletes a
     LEFT JOIN whereabouts_filings f ON f.athlete_id = a.id AND f.filing_date = ?
     LEFT JOIN allowed_locations o ON o.id = f.overnight_location_id
     LEFT JOIN allowed_locations s ON s.id = f.slot_location_id
     WHERE ${where}
     ORDER BY a.last_name, a.first_name`,
    params
  );

  const filingIds = rows.filter((r) => r.filing_id).map((r) => r.filing_id);
  const acts = filingIds.length
    ? await query(
      `SELECT fa.filing_id, fa.id, fa.activity_type, fa.start_time, fa.end_time, fa.description, ${LOC_COLS('l', 'l')}
       FROM filing_activities fa JOIN allowed_locations l ON l.id = fa.location_id
       WHERE fa.filing_id IN (?) ORDER BY fa.start_time`,
      [filingIds]
    )
    : [];
  const actsByFiling = new Map();
  for (const a of acts) {
    if (!actsByFiling.has(a.filing_id)) actsByFiling.set(a.filing_id, []);
    actsByFiling.get(a.filing_id).push({
      id: a.id, type: a.activity_type, start: a.start_time.slice(0, 5), end: a.end_time.slice(0, 5),
      description: a.description, location: pickLoc(a, 'l'),
    });
  }

  const filingsByAthlete = new Map();
  for (const r of rows) {
    if (!r.filing_id) continue;
    filingsByAthlete.set(r.athlete_id, {
      id: r.filing_id,
      slotStart: r.slot_start.slice(0, 5),
      slotEnd: r.slot_end.slice(0, 5),
      overnight: pickLoc(r, 'o'),
      slot: pickLoc(r, 's'),
      activities: actsByFiling.get(r.filing_id) || [],
      notes: r.notes, source: r.source, version: r.version,
      submittedAt: r.submitted_at, updatedAt: r.updated_at,
    });
  }

  const [conflicts, fails] = await Promise.all([
    conflictsFor(rows.map((r) => r.athlete_id), day, filingsByAthlete),
    failureCounts(now.date),
  ]);

  const athletes = rows.map((r) => {
    const filing = filingsByAthlete.get(r.athlete_id) || null;
    const failures = fails.get(r.athlete_id) || 0;
    return {
      athlete: {
        id: r.athlete_id, code: r.athlete_code, name: `${r.first_name} ${r.last_name}`,
        firstName: r.first_name, lastName: r.last_name, sport: r.sport, discipline: r.discipline,
        nationality: r.nationality, pool: r.testing_pool, status: r.athlete_status,
      },
      filing,
      live: liveState(filing, day, now),
      conflicts: conflicts.get(r.athlete_id) || [],
      failures: { count: failures, ...riskLevel(failures) },
    };
  });

  const summary = {
    total: athletes.length,
    filed: athletes.filter((a) => a.filing).length,
    missing: athletes.filter((a) => !a.filing).length,
    inSlotNow: athletes.filter((a) => a.live.slotState === 'active').length,
    upcomingNextHour: athletes.filter((a) => a.live.slotState === 'upcoming' && a.live.secondsToSlot !== undefined && a.live.secondsToSlot <= 3600).length,
    conflicts: athletes.filter((a) => a.conflicts.length).length,
    atRisk: athletes.filter((a) => ['high', 'critical'].includes(a.failures.level)).length,
  };

  return { date: day, isToday: day === now.date, serverNow: now, timeZone: env.appTz, summary, athletes };
}

/** Quarter filing coverage for every athlete (which days are filed / missing). */
async function getCoverage(which = 'current') {
  const today = t.todayInTz(env.appTz);
  const quarter = which === 'next' ? t.nextQuarter(today) : t.quarterOf(today);
  const deadline = t.quarterDeadline(quarter, env.rules.quarterlyDeadlineDay);
  // For the quarter already under way, only the days still to come can be filed.
  const from = which === 'next' ? quarter.start : today;
  const totalDays = t.diffDays(quarter.end, from) + 1;

  const athletes = await query(
    "SELECT id, athlete_code, first_name, last_name, sport FROM athletes WHERE status <> 'Retired' ORDER BY last_name"
  );
  const filings = await query(
    'SELECT athlete_id, filing_date FROM whereabouts_filings WHERE filing_date BETWEEN ? AND ?',
    [from, quarter.end]
  );
  const byAthlete = new Map();
  for (const f of filings) {
    if (!byAthlete.has(f.athlete_id)) byAthlete.set(f.athlete_id, new Set());
    byAthlete.get(f.athlete_id).add(f.filing_date);
  }

  const rows = athletes.map((a) => {
    const set = byAthlete.get(a.id) || new Set();
    const days = [];
    const missing = [];
    for (let d = from; d <= quarter.end; d = t.addDays(d, 1)) {
      const filed = set.has(d);
      days.push(filed ? 1 : 0);
      if (!filed) missing.push(d);
    }
    return {
      athlete: { id: a.id, code: a.athlete_code, name: `${a.first_name} ${a.last_name}`, sport: a.sport },
      filed: set.size, total: totalDays, pct: Math.round((set.size / totalDays) * 1000) / 10,
      complete: missing.length === 0, missingCount: missing.length,
      missingRanges: toRanges(missing), days,
    };
  });

  return {
    quarter, from, inProgress: which !== 'next', deadline, daysToDeadline: t.diffDays(deadline, today),
    deadlinePassed: today > deadline,
    complete: rows.filter((r) => r.complete).length,
    incomplete: rows.filter((r) => !r.complete).length,
    athletes: rows,
  };
}

function toRanges(dates) {
  const ranges = [];
  for (const d of dates) {
    const last = ranges[ranges.length - 1];
    if (last && t.addDays(last.to, 1) === d) last.to = d;
    else ranges.push({ from: d, to: d });
  }
  return ranges;
}

/** Validates the 60-minute slot window: start 05:00–22:00, exactly 60 minutes. */
function validateSlot(slotStart) {
  if (!t.isValidTime(slotStart)) return 'Slot start time must be HH:MM';
  const m = t.timeToMinutes(slotStart);
  if (m < SLOT_EARLIEST || m + 60 > SLOT_LATEST_END) return 'The 60-minute slot must fall between 05:00 and 23:00';
  return null;
}

module.exports = { getBoard, getCoverage, conflictsFor, liveState, riskLevel, failureCounts, validateSlot, SLOT_EARLIEST, SLOT_LATEST_END };
