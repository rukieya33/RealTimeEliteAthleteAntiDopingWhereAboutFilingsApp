// Competitions and athlete entries. Filings on competition days must place
// the athlete in the competition location, or the board flags a conflict.
import { api } from '../api.js';
import { esc, html, raw, fmtShort, fmtDate, openModal, options, showErrors, toast, formData, confirmDialog, debounce } from '../ui.js';
import * as live from '../live.js';

const LEVELS = ['International', 'Continental', 'National', 'Invitational'];

export default async function competitionsView(root, { session }) {
  const st = { rows: [], athletes: [], upcoming: true };
  root.innerHTML = `
    <div class="page-head"><div><h1>Competitions</h1>
      <p class="lede">Events your athletes are entered in, and where they take place.</p></div>
      <div class="actions">${session.canEdit ? '<button class="btn btn-primary" data-add>Add competition</button>' : ''}</div></div>
    <div class="board-controls"><label class="checks" style="margin:0"><input type="checkbox" data-upcoming checked> <span style="font-weight:400">Upcoming only</span></label></div>
    <div class="panel table-wrap" data-table></div>`;

  async function load() {
    [st.rows, st.athletes] = await Promise.all([api.get(`/api/competitions${st.upcoming ? '?upcoming=1' : ''}`), api.get('/api/athletes')]);
    const today = live.now().date;
    root.querySelector('[data-table]').innerHTML = st.rows.length ? `<table>
      <thead><tr><th>Dates</th><th>Competition</th><th>Competition location</th><th>Level</th><th>Athletes entered</th><th></th></tr></thead>
      <tbody>${st.rows.map((c) => {
        const on = c.start_date <= today && c.end_date >= today;
        return `<tr style="${on ? 'background:var(--amber-tint)' : ''}">
        <td class="num" style="white-space:nowrap">${esc(fmtShort(c.start_date))}${c.end_date !== c.start_date ? ` to ${esc(fmtShort(c.end_date))}` : ''}${on ? '<span class="sub"><span class="tag live">On now</span></span>' : ''}</td>
        <td><strong>${esc(c.name)}</strong><span class="sub">${esc(c.sport)}</span></td>
        <td>${esc(c.competition_location)}<span class="sub">${esc(c.venue)}</span></td>
        <td>${esc(c.level)}</td>
        <td>${c.entries.length ? c.entries.map((e) => `<div><a href="#/athletes/${e.athlete_id}">${esc(e.first_name)} ${esc(e.last_name)}</a> <span class="muted small">${esc(e.event_name || '')}</span>${session.canEdit ? ` <button class="btn btn-sm" style="padding:1px 6px" data-unenter="${c.id}:${e.athlete_id}" aria-label="Remove entry">✕</button>` : ''}</div>`).join('') : '<span class="muted">None</span>'}</td>
        <td style="white-space:nowrap">${session.canEdit ? `<button class="btn btn-sm" data-enter="${c.id}">Enter athlete</button> <button class="btn btn-sm" data-edit="${c.id}">Edit</button> <button class="btn btn-sm btn-danger" data-del="${c.id}">Delete</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty-state">No competitions to show. Add one so filings can be checked against it.</div>';
  }

  function form(c) {
    c = c || { level: 'International' };
    const body = html`<div class="errors hidden" role="alert"></div><form class="form-grid" novalidate>
      <div class="field full"><label for="cf-name">Name</label><input id="cf-name" name="name" value="${c.name || ''}"></div>
      <div class="field"><label for="cf-sport">Sport</label><input id="cf-sport" name="sport" value="${c.sport || ''}"></div>
      <div class="field"><label for="cf-level">Level</label><select id="cf-level" name="level">${raw(options(LEVELS, c.level))}</select></div>
      <div class="field full"><label for="cf-venue">Venue</label><input id="cf-venue" name="venue" value="${c.venue || ''}"></div>
      <div class="field"><label for="cf-city">City</label><input id="cf-city" name="city" value="${c.city || ''}"></div>
      <div class="field"><label for="cf-country">Country</label><input id="cf-country" name="country" value="${c.country || ''}"></div>
      <div class="field"><label for="cf-start">Starts</label><input id="cf-start" type="date" name="start_date" value="${c.start_date || ''}"></div>
      <div class="field"><label for="cf-end">Ends</label><input id="cf-end" type="date" name="end_date" value="${c.end_date || ''}"></div>
    </form>`;
    openModal({
      title: c.id ? `Edit ${c.name}` : 'Add competition', body, wide: true,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${c.id ? 'Save competition' : 'Add competition'}</button>`,
      onMount: (m, close) => m.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          const data = formData(m.querySelector('form'));
          if (c.id) await api.put(`/api/competitions/${c.id}`, data); else await api.post('/api/competitions', data);
          toast(c.id ? 'Competition saved' : 'Competition added', '', 'green');
          close();
          load();
        } catch (err) { showErrors(m, err); }
      }),
    });
  }

  function enterForm(c) {
    const entered = new Set(c.entries.map((e) => e.athlete_id));
    const available = st.athletes.filter((a) => !entered.has(a.id) && a.status !== 'Retired');
    openModal({
      title: `Enter an athlete in ${c.name}`,
      body: `<div class="errors hidden" role="alert"></div>
        <p class="muted">${esc(fmtDate(c.start_date))} at ${esc(c.venue)}, ${esc(c.competition_location)}.</p>
        <div class="field"><label for="ef-a">Athlete</label><select id="ef-a">${options(available, '', { label: (a) => `${a.first_name} ${a.last_name} (${a.sport})` })}</select></div>
        <div class="field"><label for="ef-e">Event</label><input id="ef-e" placeholder="e.g. 400m"></div>
        <p class="small muted">Remember to update the athlete's filing for these dates and add the venue or hotel to their allowed locations.</p>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Enter athlete</button>',
      onMount: (m, close) => m.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await api.post(`/api/competitions/${c.id}/entries`, { athlete_id: m.querySelector('#ef-a').value, event_name: m.querySelector('#ef-e').value });
          toast('Athlete entered', '', 'green');
          close();
          load();
        } catch (err) { showErrors(m, err); }
      }),
    });
  }

  root.addEventListener('click', async (e) => {
    const t = e.target;
    const find = (attr) => st.rows.find((r) => r.id === Number(t.closest(`[${attr}]`).getAttribute(attr)));
    if (t.closest('[data-add]')) return form(null);
    if (t.closest('[data-edit]')) return form(find('data-edit'));
    if (t.closest('[data-enter]')) return enterForm(find('data-enter'));
    if (t.closest('[data-unenter]')) {
      const [cid, aid] = t.closest('[data-unenter]').dataset.unenter.split(':');
      if (await confirmDialog('Remove this athlete from the competition?', 'Remove entry')) { await api.del(`/api/competitions/${cid}/entries/${aid}`); load(); }
      return;
    }
    if (t.closest('[data-del]')) {
      const c = find('data-del');
      if (await confirmDialog(`Delete ${c.name}? Linked travel bookings are kept.`, 'Delete competition')) { await api.del(`/api/competitions/${c.id}`); toast('Competition deleted'); load(); }
    }
  });
  root.querySelector('[data-upcoming]').addEventListener('change', (e) => { st.upcoming = e.target.checked; load(); });

  await load();
  return live.on('competition.changed', debounce(() => load().catch(() => {}), 300));
}
