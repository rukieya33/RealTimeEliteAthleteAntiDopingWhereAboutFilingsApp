'use strict';

// Unit tests for date handling and live slot logic (no database needed).
const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/utils/time');
const { liveState, validateSlot, riskLevel } = require('../src/services/compliance');

const loc = (label, city = 'Kestrelford') => ({ id: label, label, city });
const filing = {
  slotStart: '06:00', slotEnd: '07:00',
  overnight: loc('Home'), slot: loc('Home'),
  activities: [{ type: 'Training', start: '09:30', end: '12:00', description: 'Main session', location: loc('Track') }],
};
const at = (date, hh, mm) => ({ date, minutes: hh * 60 + mm, seconds: (hh * 60 + mm) * 60 });

test('quarters and filing deadlines', () => {
  assert.deepStrictEqual(t.quarterOf('2026-11-24'), { year: 2026, q: 4, start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' });
  const next = t.nextQuarter('2026-11-24');
  assert.strictEqual(next.label, 'Q1 2027');
  assert.strictEqual(next.end, '2027-03-31');
  assert.strictEqual(t.quarterDeadline(next, 15), '2026-12-15');
});

test('date arithmetic crosses months and leap years', () => {
  assert.strictEqual(t.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(t.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(t.diffDays('2027-01-01', '2026-12-25'), 7);
  assert.ok(t.isValidDate('2026-02-28'));
  assert.ok(!t.isValidDate('2026-02-30'));
});

test('60-minute slot must sit between 05:00 and 23:00', () => {
  assert.strictEqual(validateSlot('05:00'), null);
  assert.strictEqual(validateSlot('22:00'), null);
  assert.ok(validateSlot('04:59'));
  assert.ok(validateSlot('22:15'));
  assert.ok(validateSlot('nonsense'));
});

test('live state: inside the slot', () => {
  const s = liveState(filing, '2026-11-24', at('2026-11-24', 6, 15));
  assert.strictEqual(s.slotState, 'active');
  assert.strictEqual(s.expected.label, 'Home');
  assert.strictEqual(s.secondsRemaining, 45 * 60);
});

test('live state: during a declared activity after the slot', () => {
  const s = liveState(filing, '2026-11-24', at('2026-11-24', 10, 0));
  assert.strictEqual(s.slotState, 'completed');
  assert.strictEqual(s.expected.label, 'Track');
});

test('live state: overnight hours and gaps', () => {
  assert.strictEqual(liveState(filing, '2026-11-24', at('2026-11-24', 23, 30)).expected.label, 'Home');
  const gap = liveState(filing, '2026-11-24', at('2026-11-24', 14, 0));
  assert.strictEqual(gap.expected, null);
  assert.strictEqual(gap.fallback.label, 'Home');
});

test('live state: no filing and future days', () => {
  assert.strictEqual(liveState(null, '2026-11-24', at('2026-11-24', 9, 0)).slotState, 'none');
  assert.strictEqual(liveState(filing, '2026-11-25', at('2026-11-24', 9, 0)).slotState, 'upcoming');
});

test('failure risk levels', () => {
  assert.strictEqual(riskLevel(0).level, 'ok');
  assert.strictEqual(riskLevel(1).level, 'warning');
  assert.strictEqual(riskLevel(2).level, 'high');
  assert.strictEqual(riskLevel(3).level, 'critical');
});
