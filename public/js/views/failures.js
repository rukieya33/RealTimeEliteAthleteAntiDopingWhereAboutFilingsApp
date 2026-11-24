// Whereabouts failures (filing failures and missed tests) over the rolling window.
import { api } from '../api.js';
import { esc, html, raw, fmtDate, openModal, options, showErrors, toast, formData, debounce } from '../ui.js';
import * as live from '../live.js';

export default async function failuresView(root, { session }) {
  const st = { rows: [], athletes: [] };
  const rules = session.meta.rules;
  root.innerHTML = `
    <div class="page-head"><div><h1>Whereabouts failures</h1>
      <p class="lede">Filing failures and missed tests. ${rules.failureThreshold} confirmed or pending failures within ${rules.failureWindowMonths} months is flagged as a potential rule violation.</p></div>
      <div class="actions">${session.canEdit ? '<button class="btn btn-primary" data-add>Record failure</button>' : ''}</div></div>
    <div class="panel table-wrap" data-table></div>`;

  async function load() {
    [st.rows, st.athletes] = await Promise.all([api.get('/api/failures'), api.get('/api/athletes')]);
    const since = new Date(live.now().jsDate);
    since.setMonth(since.getMonth() - rules.failureWindowMonths);
    const cutoff = since.toISOString().slice(0, 10);
    root.querySelector('[data-table]').innerHTML = st.rows.length ? `<table>
      <thead><tr><th>Date</th><th>Athlete</th><th>Type</th><th>Details</th><th>Counts towards risk</th><th>Status</th></tr></thead>
      <tbody>${st.rows.map((f) => `<tr>
        <td class="num" style="white-space:nowrap">${esc(fmtDate(f.incident_date))}</td>
        <td><a href="#/athletes/${f.athlete_id}">${esc(f.first_name)} ${esc(f.last_name)}</a></td>
        <td>${esc(f.failure_type)}</td>
        <td>${esc(f.description || '')}</td>
        <td>${f.status !== 'Dismissed' && f.incident_date > cutoff ? 'Yes' : '<span class="muted">No</span>'}</td>
        <td>${session.canEdit ? `<select data-status="${f.id}" aria-label="Status">${options(['Under Review', 'Confirmed', 'Dismissed'], f.status)}</select>` : esc(f.status)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty-state">No whereabouts failures recorded.</div>';
  }

  root.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-status]');
    if (!sel) return;
    try { await api.put(`/api/failures/${sel.dataset.status}`, { status: sel.value }); toast('Status updated', sel.value, 'green'); } catch (err) { toast('Could not update', err.message, 'red'); }
  });
  root.addEventListener('click', (e) => {
    if (!e.target.closest('[data-add]')) return;
    const body = html`<div class="errors hidden" role="alert"></div><form class="form-grid" novalidate>
      <div class="field"><label for="ff-a">Athlete</label><select id="ff-a" name="athlete_id">${raw(options(st.athletes, '', { label: (a) => `${a.first_name} ${a.last_name}` }))}</select></div>
      <div class="field"><label for="ff-t">Type</label><select id="ff-t" name="failure_type">${raw(options(['Filing Failure', 'Missed Test'], 'Missed Test'))}</select></div>
      <div class="field"><label for="ff-d">Incident date</label><input id="ff-d" type="date" name="incident_date" value="${live.now().date}"></div>
      <div class="field"><label for="ff-s">Status</label><select id="ff-s" name="status">${raw(options(['Under Review', 'Confirmed', 'Dismissed'], 'Under Review'))}</select></div>
      <div class="field full"><label for="ff-desc">What happened</label><textarea id="ff-desc" name="description"></textarea></div>
    </form>`;
    openModal({
      title: 'Record a whereabouts failure', body, wide: true,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Record failure</button>',
      onMount: (m, close) => m.querySelector('[data-save]').addEventListener('click', async () => {
        try { await api.post('/api/failures', formData(m.querySelector('form'))); toast('Failure recorded', '', 'red'); close(); load(); } catch (err) { showErrors(m, err); }
      }),
    });
  });

  await load();
  return live.on('failure.changed', debounce(() => load().catch(() => {}), 300));
}
