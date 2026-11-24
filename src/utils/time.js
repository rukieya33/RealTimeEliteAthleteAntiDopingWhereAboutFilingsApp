'use strict';

/**
 * Date/time helpers. Whereabouts dates and slot times are "wall clock" values
 * in the agency time zone (APP_TZ), so all comparisons go through these helpers
 * rather than the server's local time.
 */

const pad = (n) => String(n).padStart(2, '0');

function nowParts(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}:${p.second}`;
  return {
    date,
    time,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

function todayInTz(tz) {
  return nowParts(tz).date;
}

function toUTCDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTCDate(dt) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addDays(dateStr, n) {
  const dt = toUTCDate(dateStr);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUTCDate(dt);
}

function diffDays(a, b) {
  return Math.round((toUTCDate(a) - toUTCDate(b)) / 86400000);
}

function dayOfWeek(dateStr) {
  return toUTCDate(dateStr).getUTCDay(); // 0 = Sunday
}

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(mins) {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  return fromUTCDate(toUTCDate(s)) === s;
}

function isValidTime(s) {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s || '');
}

/** Quarter containing dateStr: { year, q, start, end, label } */
function quarterOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  const startMonth = (q - 1) * 3 + 1;
  const start = `${y}-${pad(startMonth)}-01`;
  const end = addDays(q === 4 ? `${y + 1}-01-01` : `${y}-${pad(startMonth + 3)}-01`, -1);
  return { year: y, q, start, end, label: `Q${q} ${y}` };
}

function nextQuarter(dateStr) {
  return quarterOf(addDays(quarterOf(dateStr).end, 1));
}

/** Quarterly filing deadline: day N of the month before the quarter begins. */
function quarterDeadline(quarter, deadlineDay) {
  const monthBefore = addDays(quarter.start, -1).slice(0, 7);
  return `${monthBefore}-${pad(deadlineDay)}`;
}

function addMonths(dateStr, n) {
  const dt = toUTCDate(dateStr);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return fromUTCDate(dt);
}

module.exports = {
  nowParts, todayInTz, addDays, diffDays, dayOfWeek, timeToMinutes, minutesToTime,
  isValidDate, isValidTime, quarterOf, nextQuarter, quarterDeadline, addMonths,
};
