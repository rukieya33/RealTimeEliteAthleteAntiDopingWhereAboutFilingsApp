'use strict';

/**
 * Imports athletes (and their allowed locations) from CSV text.
 *
 * Header names are matched loosely (case, spaces and punctuation ignored), so
 * "Athlete Code", "athlete_code" and "ATHLETE-CODE" all work.
 *
 * Required columns: first_name, last_name, sport, nationality
 * Optional columns: athlete_code, gender, date_of_birth, discipline,
 *   testing_pool, email, phone, agent_name, status, allowed_locations
 *
 * allowed_locations: entries separated by ";" — each entry is
 *   "Label | Address | City | Country"  (Type may be added as a 5th part)
 * e.g. "Home | 14 Harrow Lane | Kestrelford | United Kingdom | Home"
 */
const { parse } = require('csv-parse/sync');

const LOCATION_TYPES = ['Home', 'Training', 'Gym', 'Medical', 'Family', 'Hotel', 'Competition Venue', 'Training Camp', 'Other'];
const ALIASES = {
  athletecode: 'athlete_code', code: 'athlete_code', id: 'athlete_code', athleteid: 'athlete_code',
  firstname: 'first_name', forename: 'first_name', givenname: 'first_name',
  lastname: 'last_name', surname: 'last_name', familyname: 'last_name',
  name: 'full_name', fullname: 'full_name', athletename: 'full_name', athlete: 'full_name',
  gender: 'gender', sex: 'gender',
  dateofbirth: 'date_of_birth', dob: 'date_of_birth', birthdate: 'date_of_birth',
  nationality: 'nationality', country: 'nationality',
  sport: 'sport', discipline: 'discipline', event: 'discipline',
  testingpool: 'testing_pool', pool: 'testing_pool',
  email: 'email', phone: 'phone', mobile: 'phone',
  agent: 'agent_name', agentname: 'agent_name',
  status: 'status',
  allowedlocations: 'allowed_locations', locations: 'allowed_locations', allowedlocation: 'allowed_locations',
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function mapRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = ALIASES[norm(k)];
    if (key && v !== undefined && String(v).trim() !== '') out[key] = String(v).trim();
  }
  if (out.full_name && (!out.first_name || !out.last_name)) {
    const parts = out.full_name.split(/\s+/);
    out.first_name = out.first_name || parts.shift();
    out.last_name = out.last_name || parts.join(' ') || '-';
  }
  delete out.full_name;
  return out;
}

function parseLocations(text) {
  if (!text) return [];
  return text.split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [label, address, city, country, type] = entry.split('|').map((p) => (p || '').trim());
    const t = LOCATION_TYPES.find((x) => x.toLowerCase() === (type || label || '').toLowerCase());
    return {
      label: label || 'Location',
      address_line: address || label || 'Unknown address',
      city: city || 'Unknown',
      country: country || 'Unknown',
      location_type: t || (/home/i.test(label) ? 'Home' : /hotel/i.test(label) ? 'Hotel' : /gym/i.test(label) ? 'Gym' : 'Training'),
    };
  });
}

function normaliseGender(g) {
  if (!g) return 'Other';
  const s = g.toLowerCase();
  if (s.startsWith('f') || s === 'w' || s.startsWith('wom')) return 'Female';
  if (s.startsWith('m')) return 'Male';
  return 'Other';
}

function normalisePool(p) {
  if (!p) return 'RTP';
  const s = p.toUpperCase();
  if (s.includes('RTP') || s.includes('REGISTERED')) return 'RTP';
  if (s === 'TP' || s.includes('TESTING POOL')) return 'TP';
  return 'Other';
}

/**
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {string} csvText
 * @returns {Promise<{created:number, updated:number, locations:number, errors:string[]}>}
 */
async function importAthletesCsv(conn, csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  const result = { created: 0, updated: 0, locations: 0, errors: [] };

  const [[{ maxId }]] = await conn.query('SELECT COALESCE(MAX(id),0) AS maxId FROM athletes');
  let nextCode = 1001 + Number(maxId);

  for (let i = 0; i < records.length; i++) {
    const row = mapRow(records[i]);
    const line = i + 2;
    if (!row.first_name || !row.last_name || !row.sport || !row.nationality) {
      result.errors.push(`Row ${line}: first_name, last_name, sport and nationality are required`);
      continue;
    }
    const athlete = {
      athlete_code: row.athlete_code || `ATH-${nextCode++}`,
      first_name: row.first_name,
      last_name: row.last_name,
      gender: normaliseGender(row.gender),
      date_of_birth: /^\d{4}-\d{2}-\d{2}$/.test(row.date_of_birth || '') ? row.date_of_birth : null,
      nationality: row.nationality,
      sport: row.sport,
      discipline: row.discipline || null,
      testing_pool: normalisePool(row.testing_pool),
      email: row.email || null,
      phone: row.phone || null,
      agent_name: row.agent_name || null,
      status: ['Active', 'Injured', 'Retired', 'Suspended'].includes(row.status) ? row.status : 'Active',
    };

    const [existing] = await conn.query('SELECT id FROM athletes WHERE athlete_code = ?', [athlete.athlete_code]);
    let athleteId;
    if (existing.length) {
      athleteId = existing[0].id;
      await conn.query('UPDATE athletes SET ? WHERE id = ?', [athlete, athleteId]);
      result.updated += 1;
    } else {
      const [res] = await conn.query('INSERT INTO athletes SET ?', [athlete]);
      athleteId = res.insertId;
      result.created += 1;
    }

    for (const loc of parseLocations(row.allowed_locations)) {
      const [dupe] = await conn.query(
        'SELECT id FROM allowed_locations WHERE athlete_id = ? AND label = ? AND address_line = ?',
        [athleteId, loc.label, loc.address_line]
      );
      if (dupe.length) continue;
      await conn.query('INSERT INTO allowed_locations SET ?', [{ athlete_id: athleteId, ...loc }]);
      result.locations += 1;
    }
  }
  return result;
}

module.exports = { importAthletesCsv, parseLocations, mapRow };
