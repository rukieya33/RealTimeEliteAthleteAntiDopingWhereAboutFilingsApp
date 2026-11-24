// Live connection: server-synchronised clock in the agency time zone and the
// Server-Sent Events stream that pushes every whereabouts change instantly.
import { toast } from './ui.js';

const listeners = new Map();
let skewMs = 0;
let timeZone = 'Europe/London';
let source = null;
let me = '';

export function setUser(name) { me = name; }
const fmtD = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export const state = { connected: false, clients: 0 };

export function setTimeZone(tz) { timeZone = tz; }
export function getTimeZone() { return timeZone; }

/** "Now" in the agency time zone, corrected for client clock drift. */
export function now() {
  const d = new Date(Date.now() + skewMs);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const h = Number(p.hour); const m = Number(p.minute); const s = Number(p.second);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`,
    minutes: h * 60 + m,
    seconds: h * 3600 + m * 60 + s,
    jsDate: d,
  };
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}

function emit(type, data) {
  (listeners.get(type) || []).forEach((fn) => fn(data));
  (listeners.get('*') || []).forEach((fn) => fn(type, data));
}

function syncSkew(data) {
  if (data && data.at) skewMs = Date.parse(data.at) - Date.now();
}

function setConn(ok) {
  state.connected = ok;
  const el = document.getElementById('conn');
  if (!el) return;
  el.className = `conn ${ok ? 'live' : 'down'}`;
  el.textContent = ok ? (state.clients > 1 ? `Live, ${state.clients} viewing` : 'Live') : 'Reconnecting';
}

const EVENTS = ['hello', 'presence', 'tick', 'activity', 'filing.created', 'filing.updated', 'filing.deleted', 'filing.bulk',
  'slot.started', 'slot.ended', 'day.changed', 'athlete.changed', 'location.changed', 'travel.changed',
  'competition.changed', 'failure.changed'];

export function connect() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onopen = () => setConn(true);
  source.onerror = () => setConn(false);
  for (const type of EVENTS) {
    source.addEventListener(type, (e) => {
      const data = JSON.parse(e.data);
      syncSkew(data);
      if (type === 'hello' || type === 'presence') { state.clients = data.connectedClients; setConn(true); }
      emit(type, data);
    });
  }

  // App-wide notifications for things everybody should see.
  on('slot.started', (d) => toast(`${d.athleteName}: 60-minute slot open`, `${d.slot} at ${d.location}`, 'amber'));
  on('slot.ended', (d) => toast(`${d.athleteName}: slot closed`, d.slot, ''));
  on('filing.updated', (d) => d.slotChanged && d.by !== me && toast(`${d.athleteName}: slot changed`, `Updated by ${d.by} for ${fmtD(d.date)}`, 'amber'));
  on('filing.created', (d) => d.by !== me && toast(`${d.athleteName}: whereabouts filed`, `Filed by ${d.by} for ${fmtD(d.date)}`, 'green'));
  on('day.changed', () => toast('New day', 'The board has moved to today.'));
}

// Header clock ticks every second.
export function startClock() {
  const t = document.getElementById('clock-time');
  const d = document.getElementById('clock-date');
  const fmt = () => {
    const n = now();
    t.textContent = n.time;
    d.textContent = `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(n.jsDate)}, ${timeZone.split('/').pop().replace('_', ' ')} time`;
    emit('second', n);
  };
  fmt();
  setInterval(fmt, 1000);
}
