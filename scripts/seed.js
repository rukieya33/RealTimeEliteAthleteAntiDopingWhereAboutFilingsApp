'use strict';

/**
 * Seeds the database with athletes, allowed locations, competitions, travel
 * bookings, whereabouts filings and failures.
 *
 * All dates are generated relative to "today" in APP_TZ, so after seeding the
 * app always shows a live, current picture: filings run from four weeks ago to
 * the end of next quarter, with a few deliberate gaps so the compliance alerts
 * have something to show.
 */
const bcrypt = require('bcryptjs');
const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const t = require('../src/utils/time');
const athletesData = require('../db/data/athletes.json').athletes;
const compData = require('../db/data/competitions.json');

// Deterministic pseudo-random generator so every seed looks the same.
let seedState = 20261124;
function rand() {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

async function insert(conn, table, row) {
  const [res] = await conn.query(`INSERT INTO ${table} SET ?`, [row]);
  return res.insertId;
}

async function bulkInsert(conn, table, cols, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await conn.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ?`, [chunk]);
  }
}

async function main() {
  const conn = await pool.getConnection();
  const today = t.todayInTz(env.appTz);
  const now = t.nowParts(env.appTz);
  console.log(`Seeding relative to ${today} (${env.appTz})`);

  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const tbl of ['audit_log', 'whereabouts_failures', 'filing_activities', 'whereabouts_filings',
      'competition_entries', 'competitions', 'travel_bookings', 'allowed_locations', 'athletes', 'users']) {
      await conn.query(`TRUNCATE TABLE ${tbl}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // ---- Users ----------------------------------------------------------
    const adminHash = await bcrypt.hash(env.seedAdmin.password, 10);
    const demoHash = await bcrypt.hash('Demo1234!', 10);
    const adminId = await insert(conn, 'users', { full_name: 'Agency Administrator', email: env.seedAdmin.email, password_hash: adminHash, role: 'admin' });
    await insert(conn, 'users', { full_name: 'Whereabouts Manager', email: 'manager@agency.test', password_hash: demoHash, role: 'manager' });
    await insert(conn, 'users', { full_name: 'Read-only Viewer', email: 'viewer@agency.test', password_hash: demoHash, role: 'viewer' });

    // ---- Athletes & allowed locations -----------------------------------
    const athletes = {}; // code -> { id, locations: {type/label -> id}, home, ... }
    for (const a of athletesData) {
      const { locations, ...row } = a;
      const id = await insert(conn, 'athletes', row);
      const rec = { id, code: a.athlete_code, data: a, locs: [] };
      for (const loc of locations) {
        const locId = await insert(conn, 'allowed_locations', { athlete_id: id, ...loc });
        rec.locs.push({ id: locId, ...loc });
      }
      athletes[a.athlete_code] = rec;
    }
    const locOf = (rec, type) => rec.locs.find((l) => l.location_type === type);

    // ---- Competitions, entries, hotels & travel ------------------------
    const compWindows = {}; // athlete code -> [{ from, to, start, end, hotelId, venueId }]
    let bookingNo = 4100;
    for (const c of compData.competitions) {
      const start = t.addDays(today, c.start_offset);
      const end = t.addDays(start, c.duration_days - 1);
      const compId = await insert(conn, 'competitions', {
        name: c.name, sport: c.sport, level: c.level, venue: c.venue,
        competition_location: `${c.city}, ${c.country}`, city: c.city, country: c.country,
        start_date: start, end_date: end,
      });
      for (const e of c.entries) {
        const rec = athletes[e.athlete_code];
        if (!rec) continue;
        await insert(conn, 'competition_entries', { competition_id: compId, athlete_id: rec.id, event_name: e.event_name, entry_status: 'Confirmed' });

        // The competition venue (and hotel) become allowed locations for the athlete.
        const venueId = await insert(conn, 'allowed_locations', {
          athlete_id: rec.id, label: c.venue, location_type: 'Competition Venue',
          address_line: c.venue, city: c.city, country: c.country, access_notes: `Competition: ${c.name}`,
        });
        rec.locs.push({ id: venueId, location_type: 'Competition Venue', city: c.city });
        let hotelId = null;
        if (c.hotel) {
          hotelId = await insert(conn, 'allowed_locations', {
            athlete_id: rec.id, label: c.hotel.label, location_type: 'Hotel',
            address_line: c.hotel.address_line, city: c.city, country: c.country, postcode: c.hotel.postcode,
            access_notes: 'Room number confirmed at check-in',
          });
          rec.locs.push({ id: hotelId, location_type: 'Hotel', city: c.city });
        }
        const home = locOf(rec, 'Home');
        const travelsAway = home.city !== c.city;
        (compWindows[rec.code] = compWindows[rec.code] || []).push({
          from: travelsAway ? t.addDays(start, -1) : start, to: end, start, end,
          hotelId: hotelId || home.id, venueId,
        });

        if (travelsAway) {
          const sameCountry = home.country === c.country;
          const travelType = sameCountry ? 'Train' : 'Flight';
          const carrier = pick(compData.carriers[travelType]);
          const outDepart = t.addDays(start, -1);
          const outHour = 8 + Math.floor(rand() * 4);
          await insert(conn, 'travel_bookings', {
            athlete_id: rec.id, competition_id: compId, booking_ref: `TB-${bookingNo++}`,
            travel_type: travelType, carrier,
            travel_booking_location: `${c.city}, ${c.country}`,
            origin: `${home.city}, ${home.country}`, destination_city: c.city,
            depart_at: `${outDepart} ${String(outHour).padStart(2, '0')}:15:00`,
            arrive_at: `${outDepart} ${String(outHour + (sameCountry ? 3 : 5)).padStart(2, '0')}:40:00`,
            accommodation: c.hotel ? c.hotel.label.replace('Hotel – ', '') : 'Home',
            status: 'Confirmed',
          });
          const back = t.addDays(end, 1);
          await insert(conn, 'travel_bookings', {
            athlete_id: rec.id, competition_id: compId, booking_ref: `TB-${bookingNo++}`,
            travel_type: travelType, carrier,
            travel_booking_location: `${home.city}, ${home.country}`,
            origin: `${c.city}, ${c.country}`, destination_city: home.city,
            depart_at: `${back} 10:05:00`, arrive_at: `${back} ${sameCountry ? '13' : '16'}:30:00`,
            accommodation: 'Home', status: 'Booked',
          });
        }
      }
    }

    // Training-camp blocks for athletes who have a camp location.
    const campBlocks = {};
    let campOffset = 30;
    for (const rec of Object.values(athletes)) {
      const camp = locOf(rec, 'Training Camp');
      if (camp) {
        const from = t.addDays(today, campOffset);
        campBlocks[rec.code] = { from, to: t.addDays(from, 9), campId: camp.id };
        campOffset += 6;
      }
    }

    // ---- Whereabouts filings -------------------------------------------
    const firstDay = t.addDays(today, -28);
    const lastDay = t.nextQuarter(today).end;
    const gaps = {
      // Missing today/tomorrow -> live "no filing" alert.
      'ATH-1012': (d) => (d >= today && d <= t.addDays(today, 1)) || d >= t.nextQuarter(today).start,
      // Next quarter only partly filed -> deadline warning.
      'ATH-1006': (d) => d >= t.addDays(t.nextQuarter(today).start, 40),
      'ATH-1003': (d) => d >= t.addDays(t.nextQuarter(today).start, 70),
    };
    const slotPrefs = [6 * 60, 6 * 60 + 30, 7 * 60, 6 * 60, 21 * 60, 7 * 60 + 30];

    const filingRows = [];
    const activityPlans = [];
    let idx = 0;
    for (const rec of Object.values(athletes)) {
      const home = locOf(rec, 'Home');
      const training = locOf(rec, 'Training') || home;
      const gym = locOf(rec, 'Gym');
      const medical = locOf(rec, 'Medical');
      const prefSlot = slotPrefs[idx % slotPrefs.length];
      idx += 1;

      for (let d = firstDay; d <= lastDay; d = t.addDays(d, 1)) {
        if (gaps[rec.code] && gaps[rec.code](d)) continue;
        const dow = t.dayOfWeek(d);
        const comp = (compWindows[rec.code] || []).find((w) => d >= w.from && d <= w.to);
        const camp = campBlocks[rec.code] && d >= campBlocks[rec.code].from && d <= campBlocks[rec.code].to ? campBlocks[rec.code] : null;

        let overnight = home.id;
        let slotLoc = home.id;
        let slotStart = prefSlot;
        const acts = [];
        let notes = null;

        if (comp) {
          overnight = comp.hotelId;
          slotLoc = comp.hotelId;
          slotStart = 7 * 60;
          if (d >= comp.start && d <= comp.end) {
            acts.push(['Competition', comp.venueId, '10:00:00', '18:00:00', 'Competition day']);
          } else {
            acts.push(['Travel', comp.hotelId, '09:00:00', '16:00:00', 'Travel to competition']);
          }
          notes = 'Competition period';
        } else if (camp) {
          overnight = camp.campId;
          slotLoc = camp.campId;
          slotStart = 6 * 60 + 30;
          acts.push(['Training', camp.campId, '09:00:00', '12:00:00', 'Camp session AM']);
          acts.push(['Training', camp.campId, '15:30:00', '17:30:00', 'Camp session PM']);
          notes = 'Training camp';
        } else if (dow === 0) {
          notes = 'Rest day';
        } else {
          if (rec.data.status === 'Injured' && medical) {
            acts.push(['Medical', medical.id, '10:00:00', '12:00:00', 'Rehabilitation']);
          } else {
            acts.push(['Training', training.id, '09:30:00', '12:00:00', 'Main session']);
          }
          if ((dow === 2 || dow === 4) && gym) acts.push(['Gym', gym.id, '15:00:00', '16:30:00', 'Strength & conditioning']);
          if (dow === 3 && medical && rec.data.status !== 'Injured') acts.push(['Medical', medical.id, '14:00:00', '15:00:00', 'Physio']);
          if (dow !== 2 && dow !== 4 && rec.data.status !== 'Injured') acts.push(['Training', training.id, '16:00:00', '17:30:00', 'Second session']);
        }

        // Make today's slot for the first athlete live right now so the
        // real-time board shows an athlete inside their 60-minute window.
        if (d === today && rec.code === 'ATH-1001' && now.minutes >= 5 * 60 + 15 && now.minutes <= 22 * 60 + 15) {
          slotStart = Math.min(22 * 60, now.minutes - 15);
          slotLoc = training.id;
          notes = 'Slot moved to training venue (same-day update)';
        }

        filingRows.push([rec.id, d, overnight, t.minutesToTime(slotStart), t.minutesToTime(slotStart + 60), slotLoc, notes,
          d < today ? 'Quarterly' : (rand() < 0.15 ? 'Update' : 'Quarterly'), d < today ? 1 : (rand() < 0.2 ? 2 : 1), adminId]);
        activityPlans.push({ athleteId: rec.id, date: d, acts });
      }
    }

    await bulkInsert(conn, 'whereabouts_filings',
      ['athlete_id', 'filing_date', 'overnight_location_id', 'slot_start', 'slot_end', 'slot_location_id', 'notes', 'source', 'version', 'submitted_by'],
      filingRows);

    const [filings] = await conn.query('SELECT id, athlete_id, filing_date FROM whereabouts_filings');
    const filingIdByKey = new Map(filings.map((f) => [`${f.athlete_id}|${f.filing_date}`, f.id]));
    const actRows = [];
    for (const p of activityPlans) {
      const fid = filingIdByKey.get(`${p.athleteId}|${p.date}`);
      for (const a of p.acts) actRows.push([fid, a[0], a[1], a[2], a[3], a[4]]);
    }
    if (actRows.length) {
      await bulkInsert(conn, 'filing_activities', ['filing_id', 'activity_type', 'location_id', 'start_time', 'end_time', 'description'], actRows);
    }

    // ---- Whereabouts failures ------------------------------------------
    const failures = [
      ['ATH-1006', 'Filing Failure', -120, 'Overnight address missing for 3 days in quarterly filing', 'Confirmed'],
      ['ATH-1012', 'Missed Test', -58, 'Not present at declared training venue during 60-minute slot', 'Confirmed'],
      ['ATH-1012', 'Filing Failure', -210, 'Quarterly filing submitted after deadline', 'Confirmed'],
      ['ATH-1011', 'Missed Test', -330, 'Not available at home address during slot (hospital appointment, evidence pending)', 'Under Review'],
      ['ATH-1004', 'Filing Failure', -400, 'Late update of competition travel', 'Dismissed'],
    ];
    for (const [code, type, offset, desc, status] of failures) {
      await insert(conn, 'whereabouts_failures', {
        athlete_id: athletes[code].id, failure_type: type, incident_date: t.addDays(today, offset), description: desc, status,
      });
    }

    // ---- Audit trail ---------------------------------------------------
    await insert(conn, 'audit_log', { user_id: adminId, user_name: 'Agency Administrator', action: 'seed', entity: 'system', summary: `Database seeded with ${filingRows.length} whereabouts filings` });

    await conn.commit();
    console.log(`✔ Seeded ${athletesData.length} athletes, ${filingRows.length} filings, ${actRows.length} activities.`);
    console.log(`  Admin login:   ${env.seedAdmin.email} / ${env.seedAdmin.password}`);
    console.log('  Manager login: manager@agency.test / Demo1234!');
    console.log('  Viewer login:  viewer@agency.test / Demo1234!');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('✖ Seeding failed:', err);
  process.exit(1);
});
