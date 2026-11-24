// Athlete list, profile, allowed locations and CSV import.
import { api } from '../api.js';
import { esc, html, raw, fmtDate, fmtShort, fmtDateTime, openModal, options, showErrors, toast, formData, confirmDialog, initials, riskTag, debounce, addDays } from '../ui.js';
import * as live from '../live.js';
import { openFilingForm } from './filingForm.js';

const LOCATION_TYPES = ['Home', 'Training', 'Gym', 'Medical', 'Family', 'Hotel', 'Competition Venue', 'Training Camp', 'Other'];
const SPORT_POOLS = ['RTP', 'TP', 'Other'];
const STATUSES = ['Active', 'Injured', 'Retired', 'Suspended'];

export default async function athletesView(root, ctx) {
  if (ctx.params[0]) return profileView(root, ctx, Number(ctx.params[0]));
  return listView(root, ctx);
}

// ---------------- List ---------------------------------------------------
async function listView(root, { session }) {
  const isAdmin = session.user.role === 'admin';
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Athletes</h1><p class="lede">Elite athletes the agency files whereabouts for.</p></div>
      <div class="actions">
        ${isAdmin ? '<button class="btn" data-import>Import from CSV</button>' : ''}
        ${session.canEdit ? '<button class="btn btn-primary" data-add>Add athlete</button>' : ''}
      </div>
    </div>
    <div class="board-controls"><div class="toolbar">
      <input type="search" placeholder="Search name, code or sport" data-q aria-label="Search athletes">
    </div></div>
    <div class="panel table-wrap" data-table></div>`;

  let rows = [];
  let q = '';
  const today = live.now().date;
  const render = () => {
    const list = rows.filter((a) => !q || `${a.first_name} ${a.last_name} ${a.athlete_code} ${a.sport} ${a.nationality}`.toLowerCase().includes(q));
    root.querySelector('[data-table]').innerHTML = list.length ? `<table>
      <thead><tr><th>Athlete</th><th>Sport</th><th>Nationality</th><th>Pool</th><th>Status</th><th>Today</th><th>Filed until</th><th>Allowed locations</th><th>Failures</th><th>Agent</th></tr></thead>
      <tbody>${list.map((a) => {
        const daysAhead = a.filed_until ? Math.round((Date.parse(a.filed_until) - Date.parse(today)) / 86400000) : -1;
        return `<tr class="clickable" data-id="${a.id}" tabindex="0">
        <td><strong>${esc(a.first_name)} ${esc(a.last_name)}</strong><span class="sub">${esc(a.athlete_code)}</span></td>
        <td>${esc(a.sport)}<span class="sub">${esc(a.discipline || '')}</span></td>
        <td>${esc(a.nationality)}</td>
        <td>${esc(a.testing_pool)}</td>
        <td><span class="tag ${a.status === 'Active' ? 'ok' : a.status === 'Suspended' ? 'bad' : 'warning'}">${esc(a.status)}</span></td>
        <td>${Number(a.filed_today) ? '<span class="tag ok">Filed</span>' : '<span class="tag bad">Not filed</span>'}</td>
        <td>${a.filed_until ? `${esc(fmtShort(a.filed_until))}<span class="sub">${daysAhead >= 0 ? `${daysAhead} days ahead` : 'lapsed'}</span>` : '<span class="muted">Never</span>'}</td>
        <td class="num">${a.location_count}</td>
        <td>${riskTag(a.failures)}</td>
        <td>${esc(a.agent_name || '')}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty-state">No athletes yet. Add one, or import your athlete table from a CSV file.</div>';
  };
  const load = async () => { rows = await api.get('/api/athletes'); render(); };
  await load();

  root.querySelector('[data-q]').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); render(); });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) return athleteForm(null, (a) => { location.hash = `#/athletes/${a.id}`; });
    if (e.target.closest('[data-import]')) return importForm(load);
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/athletes/${tr.dataset.id}`;
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-id]')) e.target.click(); });
  const refresh = debounce(() => load().catch(() => {}), 400);
  const offs = ['athlete.changed', 'filing.created', 'filing.deleted', 'filing.bulk', 'location.changed', 'failure.changed', 'day.changed'].map((t) => live.on(t, refresh));
  return () => offs.forEach((o) => o());
}

function athleteForm(a, onSaved) {
  a = a || {};
  const body = html`<div class="errors hidden" role="alert"></div><form class="form-grid" novalidate>
    <div class="field"><label for="af-first">First name</label><input id="af-first" name="first_name" value="${a.first_name || ''}" required></div>
    <div class="field"><label for="af-last">Last name</label><input id="af-last" name="last_name" value="${a.last_name || ''}" required></div>
    <div class="field"><label for="af-code">Athlete code</label><input id="af-code" name="athlete_code" value="${a.athlete_code || ''}" placeholder="Created automatically if blank"></div>
    <div class="field"><label for="af-gender">Gender</label><select id="af-gender" name="gender">${raw(options(['Female', 'Male', 'Other'], a.gender || 'Female'))}</select></div>
    <div class="field"><label for="af-dob">Date of birth</label><input id="af-dob" type="date" name="date_of_birth" value="${a.date_of_birth || ''}"></div>
    <div class="field"><label for="af-nat">Nationality</label><input id="af-nat" name="nationality" value="${a.nationality || ''}" required></div>
    <div class="field"><label for="af-sport">Sport</label><input id="af-sport" name="sport" value="${a.sport || ''}" required></div>
    <div class="field"><label for="af-disc">Discipline</label><input id="af-disc" name="discipline" value="${a.discipline || ''}"></div>
    <div class="field"><label for="af-pool">Testing pool</label><select id="af-pool" name="testing_pool">${raw(options(SPORT_POOLS, a.testing_pool || 'RTP'))}</select></div>
    <div class="field"><label for="af-status">Status</label><select id="af-status" name="status">${raw(options(STATUSES, a.status || 'Active'))}</select></div>
    <div class="field"><label for="af-email">Email</label><input id="af-email" type="email" name="email" value="${a.email || ''}"></div>
    <div class="field"><label for="af-phone">Phone</label><input id="af-phone" name="phone" value="${a.phone || ''}"></div>
    <div class="field"><label for="af-agent">Agent</label><input id="af-agent" name="agent_name" value="${a.agent_name || ''}"></div>
    <div class="field full"><label for="af-notes">Notes</label><textarea id="af-notes" name="notes">${a.notes || ''}</textarea></div>
  </form>`;
  openModal({
    title: a.id ? `Edit ${a.first_name} ${a.last_name}` : 'Add athlete', body, wide: true,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${a.id ? 'Save changes' : 'Add athlete'}</button>`,
    onMount: (m, close) => m.querySelector('[data-save]').addEventListener('click', async () => {
      try {
        const data = formData(m.querySelector('form'));
        const res = a.id ? await api.put(`/api/athletes/${a.id}`, data) : await api.post('/api/athletes', data);
        toast(a.id ? 'Athlete saved' : 'Athlete added', '', 'green');
        close();
        onSaved(res);
      } catch (err) { showErrors(m, err); }
    }),
  });
}

function importForm(onDone) {
  openModal({
    title: 'Import athletes from CSV',
    body: `<div class="errors hidden" role="alert"></div>
      <p>Upload your elite athlete table as a CSV file. Athletes are matched on <strong>athlete_code</strong>: existing athletes are updated and new ones are added.</p>
      <p class="small muted">Columns: athlete_code, first_name, last_name, gender, date_of_birth, nationality, sport, discipline, testing_pool, email, phone, agent_name, status, allowed_locations. List allowed locations separated by semicolons, each as <code>Label | Address | City | Country | Type</code>.</p>
      <p class="small"><a href="/templates/athletes-import-template.csv" download>Download a template</a></p>
      <div class="field"><label for="imp-file">CSV file</label><input id="imp-file" type="file" accept=".csv,text/csv"></div>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-go>Import athletes</button>',
    onMount: (m, close) => m.querySelector('[data-go]').addEventListener('click', async () => {
      const file = m.querySelector('#imp-file').files[0];
      if (!file) return showErrors(m, { message: 'Choose a CSV file first.' });
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await api.upload('/api/import/athletes', fd);
        toast('Import finished', `${r.created} added, ${r.updated} updated, ${r.locations} allowed locations`, 'green');
        r.errors.forEach((e) => toast('Row skipped', e, 'red'));
        close();
        onDone();
      } catch (err) { showErrors(m, err); }
    }),
  });
}

// ---------------- Profile ------------------------------------------------
async function profileView(root, { session }, id) {
  const st = { a: null, filings: [] };
  const tz = live.getTimeZone();

  async function load() {
    const today = live.now().date;
    const [a, f] = await Promise.all([
      api.get(`/api/athletes/${id}`),
      api.get(`/api/filings?athlete_id=${id}&from=${addDays(today, -7)}&to=${addDays(today, 21)}`),
    ]);
    st.a = a;
    st.filings = f.filings;
    render(today);
  }

  function render(today) {
    const a = st.a;
    const name = `${a.first_name} ${a.last_name}`;
    const byDate = new Map(st.filings.map((f) => [f.filing_date, f]));
    const days = [];
    for (let i = -7; i <= 21; i++) days.push(addDays(today, i));

    root.innerHTML = `
      <p class="small"><a href="#/athletes">All athletes</a></p>
      <div class="page-head">
        <div class="profile-head"><div class="avatar">${esc(initials(name))}</div>
          <div><h1>${esc(name)}</h1><p class="lede">${esc(a.sport)}${a.discipline ? `, ${esc(a.discipline)}` : ''}. ${esc(a.nationality)}, ${esc(a.testing_pool)} testing pool. ${riskTag(a.risk)}</p></div></div>
        <div class="actions">
          ${session.canEdit ? '<button class="btn" data-edit-athlete>Edit details</button><button class="btn btn-primary" data-file>File whereabouts</button>' : ''}
          ${session.user.role === 'admin' ? '<button class="btn btn-danger" data-delete-athlete>Remove athlete</button>' : ''}
        </div>
      </div>
      <div class="grid-2 section">
        <section class="panel"><div class="panel-head"><h2>Details</h2></div><div class="panel-body">
          <dl class="kv">
            <dt>Athlete code</dt><dd>${esc(a.athlete_code)}</dd>
            <dt>Date of birth</dt><dd>${a.date_of_birth ? esc(fmtDate(a.date_of_birth, false)) : '<span class="muted">Not recorded</span>'}</dd>
            <dt>Status</dt><dd>${esc(a.status)}</dd>
            <dt>Email</dt><dd>${a.email ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : ''}</dd>
            <dt>Phone</dt><dd>${esc(a.phone || '')}</dd>
            <dt>Agent</dt><dd>${esc(a.agent_name || '')}</dd>
            ${a.notes ? `<dt>Notes</dt><dd>${esc(a.notes)}</dd>` : ''}
          </dl></div></section>
        <section class="panel"><div class="panel-head"><h2>Whereabouts, last week to three weeks ahead</h2></div>
          <div class="table-wrap" data-wb-scroll style="max-height:340px;overflow-y:auto"><table>
            <thead><tr><th>Date</th><th>Slot</th><th>Slot location</th><th>Overnight</th><th></th></tr></thead>
            <tbody>${days.map((d) => {
              const f = byDate.get(d);
              const isToday = d === today;
              if (!f) return `<tr ${isToday ? 'data-today-row' : ''} style="${isToday ? 'font-weight:600' : ''}"><td>${esc(fmtDate(d))}</td><td colspan="3"><span class="tag bad">Not filed</span></td><td>${session.canEdit && d >= today ? `<button class="btn btn-sm" data-file-date="${d}">File</button>` : ''}</td></tr>`;
              return `<tr ${isToday ? 'data-today-row' : ''} style="${isToday ? 'background:var(--amber-tint)' : ''}"><td>${esc(fmtDate(d))}${isToday ? ' <span class="tag live">Today</span>' : ''}</td>
                <td class="num" style="white-space:nowrap">${esc(f.slot_start.slice(0, 5))}–${esc(f.slot_end.slice(0, 5))}</td>
                <td>${esc(f.slot_label)}<span class="sub">${esc(f.slot_city)}</span></td>
                <td>${esc(f.overnight_label)}<span class="sub">${esc(f.overnight_city)}</span></td>
                <td>${session.canEdit && (d >= today || session.user.role === 'admin') ? `<button class="btn btn-sm" data-edit-filing="${f.id}">Update</button>` : ''}</td></tr>`;
            }).join('')}</tbody></table></div></section>
      </div>
      <section class="panel section"><div class="panel-head"><h2>Allowed locations</h2><span class="muted small">Only these can be used in a whereabouts filing.</span><span class="spacer"></span>
        ${session.canEdit ? '<button class="btn btn-sm btn-primary" data-add-loc>Add location</button>' : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>Label</th><th>Type</th><th>Address</th><th>City</th><th>Country</th><th>Access notes</th><th></th></tr></thead>
        <tbody>${a.locations.map((l) => `<tr style="${l.is_active ? '' : 'opacity:.55'}">
          <td><strong>${esc(l.label)}</strong>${l.is_active ? '' : '<span class="sub">Inactive</span>'}</td><td>${esc(l.location_type)}</td>
          <td>${esc(l.address_line)}${l.postcode ? `<span class="sub">${esc(l.postcode)}</span>` : ''}</td><td>${esc(l.city)}${l.region ? `<span class="sub">${esc(l.region)}</span>` : ''}</td><td>${esc(l.country)}</td>
          <td class="small">${esc(l.access_notes || '')}</td>
          <td style="white-space:nowrap">${session.canEdit ? `<button class="btn btn-sm" data-edit-loc="${l.id}">Edit</button> ${l.is_active ? `<button class="btn btn-sm btn-danger" data-del-loc="${l.id}">Remove</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div></section>
      <div class="grid-2 section">
        <section class="panel"><div class="panel-head"><h2>Travel bookings</h2></div>
          <ul class="list">${a.travel.length ? a.travel.map((t) => `<li><span class="when" style="width:100px">${esc(fmtDateTime(t.depart_at))}</span><span class="grow"><strong>${esc(t.travel_type)} to ${esc(t.travel_booking_location)}</strong><br><span class="muted small">From ${esc(t.origin)}, ${esc(t.booking_ref)}${t.carrier ? `, ${esc(t.carrier)}` : ''}${t.accommodation ? `. Staying at ${esc(t.accommodation)}` : ''}</span></span><span class="tag ${t.status === 'Cancelled' ? 'bad' : 'info'}">${esc(t.status)}</span></li>`).join('') : '<li class="muted">No travel booked.</li>'}</ul></section>
        <section class="panel"><div class="panel-head"><h2>Competitions</h2></div>
          <ul class="list">${a.competitions.length ? a.competitions.map((c) => `<li><span class="when">${esc(fmtShort(c.start_date))}</span><span class="grow"><strong>${esc(c.name)}</strong><br><span class="muted small">${esc(c.event_name || '')}, ${esc(c.venue)}, ${esc(c.competition_location)}</span></span></li>`).join('') : '<li class="muted">Not entered in any competitions.</li>'}</ul>
          <div class="panel-head" style="border-top:1px solid var(--rule)"><h2>Whereabouts failures</h2></div>
          <ul class="list">${a.failures.length ? a.failures.map((f) => `<li><span class="when">${esc(fmtShort(f.incident_date))}</span><span class="grow"><strong>${esc(f.failure_type)}</strong><br><span class="muted small">${esc(f.description || '')}</span></span><span class="tag ${f.status === 'Confirmed' ? 'bad' : f.status === 'Dismissed' ? '' : 'warning'}">${esc(f.status)}</span></li>`).join('') : '<li class="muted">No failures recorded.</li>'}</ul></section>
      </div>`;
    // Start the whereabouts table at today rather than a week ago.
    const box = root.querySelector('[data-wb-scroll]');
    const todayRow = root.querySelector('[data-today-row]');
    if (box && todayRow) box.scrollTop = todayRow.getBoundingClientRect().top - box.getBoundingClientRect().top - 40;
  }

  function locationForm(l) {
    l = l || {};
    const body = html`<div class="errors hidden" role="alert"></div><form class="form-grid" novalidate>
      <div class="field"><label for="lf-label">Label</label><input id="lf-label" name="label" value="${l.label || ''}" placeholder="e.g. Home, Club training ground"></div>
      <div class="field"><label for="lf-type">Type</label><select id="lf-type" name="location_type">${raw(options(LOCATION_TYPES, l.location_type || 'Home'))}</select></div>
      <div class="field full"><label for="lf-addr">Address</label><input id="lf-addr" name="address_line" value="${l.address_line || ''}"></div>
      <div class="field"><label for="lf-city">City</label><input id="lf-city" name="city" value="${l.city || ''}"></div>
      <div class="field"><label for="lf-region">Region</label><input id="lf-region" name="region" value="${l.region || ''}"></div>
      <div class="field"><label for="lf-country">Country</label><input id="lf-country" name="country" value="${l.country || ''}"></div>
      <div class="field"><label for="lf-post">Postcode</label><input id="lf-post" name="postcode" value="${l.postcode || ''}"></div>
      <div class="field full"><label for="lf-access">Access notes for testers</label><input id="lf-access" name="access_notes" value="${l.access_notes || ''}" placeholder="Door code, flat number, who to ask for"></div>
    </form>`;
    openModal({
      title: l.id ? 'Edit allowed location' : 'Add allowed location', body, wide: true,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${l.id ? 'Save location' : 'Add location'}</button>`,
      onMount: (m, close) => m.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          const data = formData(m.querySelector('form'));
          if (l.id) await api.put(`/api/locations/${l.id}`, data);
          else await api.post(`/api/athletes/${id}/locations`, data);
          toast(l.id ? 'Location saved' : 'Location added', '', 'green');
          close();
          load();
        } catch (err) { showErrors(m, err); }
      }),
    });
  }

  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-edit-athlete]')) return athleteForm(st.a, load);
    if (t.closest('[data-file]')) return openFilingForm({ athleteId: id, onSaved: load });
    if (t.closest('[data-file-date]')) return openFilingForm({ athleteId: id, date: t.closest('[data-file-date]').dataset.fileDate, onSaved: load });
    if (t.closest('[data-edit-filing]')) return openFilingForm({ filingId: Number(t.closest('[data-edit-filing]').dataset.editFiling), onSaved: load });
    if (t.closest('[data-add-loc]')) return locationForm(null);
    if (t.closest('[data-edit-loc]')) return locationForm(st.a.locations.find((l) => l.id === Number(t.closest('[data-edit-loc]').dataset.editLoc)));
    if (t.closest('[data-del-loc]')) {
      const loc = st.a.locations.find((l) => l.id === Number(t.closest('[data-del-loc]').dataset.delLoc));
      if (!(await confirmDialog(`Remove "${loc.label}" from the allowed locations?`, 'Remove location'))) return;
      const r = await api.del(`/api/locations/${loc.id}`);
      toast(r.deleted ? 'Location removed' : 'Location deactivated', r.message || '', '');
      return load();
    }
    if (t.closest('[data-delete-athlete]')) {
      if (!(await confirmDialog(`Remove ${st.a.first_name} ${st.a.last_name} and all their filings? This cannot be undone.`, 'Remove athlete'))) return;
      await api.del(`/api/athletes/${id}`);
      toast('Athlete removed', '', '');
      location.hash = '#/athletes';
    }
  });

  await load();
  const refresh = debounce((d) => { if (!d || !d.athleteId || d.athleteId === id) load().catch(() => {}); }, 300);
  const offs = ['filing.created', 'filing.updated', 'filing.deleted', 'filing.bulk', 'location.changed', 'travel.changed', 'competition.changed', 'failure.changed', 'athlete.changed', 'day.changed']
    .map((type) => live.on(type, refresh));
  return () => offs.forEach((o) => o());
}
