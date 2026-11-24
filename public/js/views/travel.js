// Travel bookings: where each athlete is travelling to (travel booking
// location), checked against their filings on the live board.
import { api } from '../api.js';
import { esc, html, raw, fmtDateTime, openModal, options, showErrors, toast, formData, confirmDialog, debounce } from '../ui.js';
import * as live from '../live.js';

const TYPES = ['Flight', 'Train', 'Car', 'Ferry', 'Coach'];
const STATUSES = ['Booked', 'Confirmed', 'Completed', 'Cancelled'];

export default async function travelView(root, { session }) {
  const st = { rows: [], athletes: [], comps: [], upcoming: true, athlete: '' };
  root.innerHTML = `
    <div class="page-head"><div><h1>Travel bookings</h1>
      <p class="lede">Journeys booked for athletes. Arrivals are checked against each day's overnight address.</p></div>
      <div class="actions">${session.canEdit ? '<button class="btn btn-primary" data-add>Add booking</button>' : ''}</div></div>
    <div class="board-controls"><div class="toolbar">
      <select data-athlete aria-label="Athlete"></select>
      <label class="checks" style="margin:0"><input type="checkbox" data-upcoming checked> <span style="font-weight:400">Upcoming only</span></label>
    </div></div>
    <div class="panel table-wrap" data-table></div>`;

  async function load() {
    const qs = new URLSearchParams();
    if (st.upcoming) qs.set('upcoming', '1');
    if (st.athlete) qs.set('athlete_id', st.athlete);
    [st.rows, st.athletes, st.comps] = await Promise.all([api.get(`/api/travel?${qs}`), api.get('/api/athletes'), api.get('/api/competitions')]);
    const sel = root.querySelector('[data-athlete]');
    sel.innerHTML = options(st.athletes, st.athlete, { label: (a) => `${a.first_name} ${a.last_name}`, blank: 'All athletes' });
    root.querySelector('[data-table]').innerHTML = st.rows.length ? `<table>
      <thead><tr><th>Reference</th><th>Athlete</th><th>Travel</th><th>From</th><th>Travel booking location</th><th>Departs</th><th>Arrives</th><th>Stay</th><th>Status</th><th></th></tr></thead>
      <tbody>${st.rows.map((b) => `<tr>
        <td class="num">${esc(b.booking_ref)}</td>
        <td><a href="#/athletes/${b.athlete_id}">${esc(b.first_name)} ${esc(b.last_name)}</a></td>
        <td>${esc(b.travel_type)}<span class="sub">${esc(b.carrier || '')}</span></td>
        <td>${esc(b.origin)}</td>
        <td><strong>${esc(b.travel_booking_location)}</strong>${b.competition_name ? `<span class="sub">For ${esc(b.competition_name)}</span>` : ''}</td>
        <td class="num">${esc(fmtDateTime(b.depart_at))}</td>
        <td class="num">${esc(fmtDateTime(b.arrive_at))}</td>
        <td>${esc(b.accommodation || '')}</td>
        <td><span class="tag ${b.status === 'Cancelled' ? 'bad' : b.status === 'Completed' ? '' : 'info'}">${esc(b.status)}</span></td>
        <td style="white-space:nowrap">${session.canEdit ? `<button class="btn btn-sm" data-edit="${b.id}">Edit</button> <button class="btn btn-sm btn-danger" data-del="${b.id}">Delete</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty-state">No travel bookings match. Add a booking so arrivals can be checked against filings.</div>';
  }

  function form(b) {
    b = b || { status: 'Confirmed', travel_type: 'Flight' };
    const dt = (v) => (v ? v.replace(' ', 'T').slice(0, 16) : '');
    const body = html`<div class="errors hidden" role="alert"></div><form class="form-grid" novalidate>
      <div class="field"><label for="tf-ath">Athlete</label><select id="tf-ath" name="athlete_id">${raw(options(st.athletes, b.athlete_id, { label: (a) => `${a.first_name} ${a.last_name}` }))}</select></div>
      <div class="field"><label for="tf-comp">For competition</label><select id="tf-comp" name="competition_id">${raw(options(st.comps, b.competition_id, { label: 'name', blank: 'Not linked to a competition' }))}</select></div>
      <div class="field"><label for="tf-type">Travel type</label><select id="tf-type" name="travel_type">${raw(options(TYPES, b.travel_type))}</select></div>
      <div class="field"><label for="tf-carrier">Carrier</label><input id="tf-carrier" name="carrier" value="${b.carrier || ''}"></div>
      <div class="field"><label for="tf-origin">From</label><input id="tf-origin" name="origin" value="${b.origin || ''}" placeholder="City, Country"></div>
      <div class="field"><label for="tf-dest">Travel booking location</label><input id="tf-dest" name="travel_booking_location" value="${b.travel_booking_location || ''}" placeholder="City, Country"></div>
      <div class="field"><label for="tf-dep">Departs</label><input id="tf-dep" type="datetime-local" name="depart_at" value="${dt(b.depart_at)}"></div>
      <div class="field"><label for="tf-arr">Arrives</label><input id="tf-arr" type="datetime-local" name="arrive_at" value="${dt(b.arrive_at)}"></div>
      <div class="field"><label for="tf-acc">Accommodation</label><input id="tf-acc" name="accommodation" value="${b.accommodation || ''}"></div>
      <div class="field"><label for="tf-status">Status</label><select id="tf-status" name="status">${raw(options(STATUSES, b.status))}</select></div>
      <div class="field"><label for="tf-ref">Booking reference</label><input id="tf-ref" name="booking_ref" value="${b.booking_ref || ''}" placeholder="Created automatically if blank"></div>
    </form>`;
    openModal({
      title: b.id ? `Edit booking ${b.booking_ref}` : 'Add travel booking', body, wide: true,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${b.id ? 'Save booking' : 'Add booking'}</button>`,
      onMount: (m, close) => m.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          const data = formData(m.querySelector('form'));
          data.destination_city = data.travel_booking_location.split(',')[0].trim();
          if (!data.competition_id) data.competition_id = null;
          if (b.id) await api.put(`/api/travel/${b.id}`, data); else await api.post('/api/travel', data);
          toast(b.id ? 'Booking saved' : 'Booking added', '', 'green');
          close();
          load();
        } catch (err) { showErrors(m, err); }
      }),
    });
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) return form(null);
    const ed = e.target.closest('[data-edit]');
    if (ed) return form(st.rows.find((r) => r.id === Number(ed.dataset.edit)));
    const del = e.target.closest('[data-del]');
    if (del) {
      const b = st.rows.find((r) => r.id === Number(del.dataset.del));
      if (await confirmDialog(`Delete booking ${b.booking_ref}?`, 'Delete booking')) { await api.del(`/api/travel/${b.id}`); toast('Booking deleted'); load(); }
    }
  });
  root.querySelector('[data-athlete]').addEventListener('change', (e) => { st.athlete = e.target.value; load(); });
  root.querySelector('[data-upcoming]').addEventListener('change', (e) => { st.upcoming = e.target.checked; load(); });

  await load();
  const off = live.on('travel.changed', debounce(() => load().catch(() => {}), 300));
  return off;
}
