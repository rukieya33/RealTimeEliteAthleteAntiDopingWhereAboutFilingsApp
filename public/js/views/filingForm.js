// Create / update / bulk-file whereabouts. Locations are limited to the
// athlete's allowed locations, and the slot is always exactly 60 minutes.
import { api } from '../api.js';
import { esc, openModal, options, showErrors, toast, confirmDialog, fmtDate } from '../ui.js';
import { now } from '../live.js';

const ACTIVITY_TYPES = ['Training', 'Competition', 'Gym', 'Medical', 'Work', 'Study', 'Travel', 'Other'];
const WEEKDAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];

function slotOptions(selected) {
  const out = [];
  for (let m = 5 * 60; m <= 22 * 60; m += 15) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const end = `${String(Math.floor((m + 60) / 60)).padStart(2, '0')}:${mm}`;
    out.push(`<option value="${hh}:${mm}" ${selected === `${hh}:${mm}` ? 'selected' : ''}>${hh}:${mm} – ${end}</option>`);
  }
  // Keep a non-15-minute existing slot selectable.
  if (selected && !out.some((o) => o.includes(`value="${selected}"`))) {
    out.unshift(`<option value="${selected}" selected>${selected} (current)</option>`);
  }
  return out.join('');
}

const locLabel = (l) => `${l.label} — ${l.city}`;

function activityRow(locs, a = {}) {
  return `<div class="activity-row">
    <select name="activity_type" aria-label="Activity type">${options(ACTIVITY_TYPES, a.activity_type || 'Training')}</select>
    <select name="location_id" aria-label="Activity location">${options(locs, a.location_id, { label: locLabel })}</select>
    <input name="start_time" type="time" aria-label="Start time" value="${esc((a.start_time || '09:00').slice(0, 5))}">
    <input name="end_time" type="time" aria-label="End time" value="${esc((a.end_time || '11:00').slice(0, 5))}">
    <input name="description" aria-label="Description" placeholder="Description" value="${esc(a.description || '')}">
    <button type="button" class="icon-btn" data-remove aria-label="Remove activity">✕</button>
  </div>`;
}

/**
 * @param {{ athleteId?: number, date?: string, filingId?: number, onSaved?: Function }} opts
 */
export async function openFilingForm({ athleteId, date, filingId, onSaved } = {}) {
  const athletes = await api.get('/api/athletes');
  let existing = null;
  if (filingId) {
    existing = await api.get(`/api/filings/${filingId}`);
    athleteId = existing.athlete_id;
    date = existing.filing_date;
  }
  const today = now().date;
  const isEdit = Boolean(existing);
  const active = athletes.filter((a) => a.status !== 'Retired');
  athleteId = athleteId || (active[0] && active[0].id);

  const body = `
    <div class="errors hidden" role="alert"></div>
    ${isEdit ? '' : `<div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-mode="single">One day</button>
      <button type="button" role="tab" aria-selected="false" data-mode="bulk">Date range (quarterly filing)</button>
    </div>`}
    <form novalidate>
      <div class="form-grid">
        <div class="field">
          <label for="ff-athlete">Athlete</label>
          <select id="ff-athlete" name="athlete_id" ${isEdit ? 'disabled' : ''}>${options(active, athleteId, { label: (a) => `${a.first_name} ${a.last_name} (${a.sport})` })}</select>
        </div>
        <div class="field" data-single>
          <label for="ff-date">Date</label>
          <input id="ff-date" name="filing_date" type="date" value="${esc(date || today)}" ${isEdit ? 'disabled' : ''}>
        </div>
        <div class="field hidden" data-bulk>
          <label for="ff-from">From</label>
          <input id="ff-from" name="from" type="date" value="${esc(date || today)}">
        </div>
        <div class="field hidden" data-bulk>
          <label for="ff-to">To</label>
          <input id="ff-to" name="to" type="date">
        </div>
        <div class="field full hidden" data-bulk>
          <label>Apply on</label>
          <div class="checks">${WEEKDAYS.map(([v, l]) => `<label><input type="checkbox" name="wd" value="${v}" checked> ${l}</label>`).join('')}
            <label><input type="checkbox" name="overwrite"> Replace days already filed</label></div>
        </div>
        <div class="field">
          <label for="ff-overnight">Overnight address</label>
          <select id="ff-overnight" name="overnight_location_id"></select>
        </div>
        <div class="field">
          <label for="ff-slot">60-minute slot</label>
          <select id="ff-slot" name="slot_start">${slotOptions(existing ? existing.slot_start.slice(0, 5) : '06:00')}</select>
          <div class="hint">Must be between 05:00 and 23:00. The athlete must be available for testing at this location for the full hour.</div>
        </div>
        <div class="field full">
          <label for="ff-slot-loc">Slot location</label>
          <select id="ff-slot-loc" name="slot_location_id"></select>
        </div>
      </div>
      <div class="field">
        <label>Regular activities</label>
        <div data-activities></div>
        <button type="button" class="btn btn-sm" data-add>Add activity</button>
      </div>
      <div class="field">
        <label for="ff-notes">Notes</label>
        <textarea id="ff-notes" name="notes" placeholder="Access instructions, reasons for a same-day change…">${esc(existing ? existing.notes || '' : '')}</textarea>
      </div>
    </form>`;

  const canWithdraw = isEdit && existing.filing_date > today;
  const footer = `${canWithdraw ? '<button type="button" class="btn btn-danger" data-withdraw style="margin-right:auto">Withdraw filing</button>' : ''}
    <button type="button" class="btn" data-close>Cancel</button>
    <button type="button" class="btn btn-primary" data-save>${isEdit ? 'Save update' : 'File whereabouts'}</button>`;

  openModal({
    title: isEdit ? `Update whereabouts for ${fmtDate(existing.filing_date)}` : 'File whereabouts',
    body, footer, wide: true,
    onMount: (modal, close) => {
      const form = modal.querySelector('form');
      const actsBox = modal.querySelector('[data-activities]');
      let mode = 'single';
      let locs = [];

      async function loadLocations(id, keep) {
        locs = await api.get(`/api/athletes/${id}/locations?active=1`);
        const home = locs.find((l) => l.location_type === 'Home') || locs[0] || {};
        const training = locs.find((l) => l.location_type === 'Training') || home;
        form.overnight_location_id.innerHTML = options(locs, keep ? existing.overnight_location_id : home.id, { label: locLabel });
        form.slot_location_id.innerHTML = options(locs, keep ? existing.slot_location_id : home.id, { label: locLabel });
        const acts = keep ? existing.activities : [{ activity_type: 'Training', location_id: training.id, start_time: '09:30', end_time: '12:00' }];
        actsBox.innerHTML = acts.map((a) => activityRow(locs, a)).join('');
        if (!locs.length) showErrors(modal, { message: 'This athlete has no allowed locations yet. Add one on their profile first.' });
      }
      loadLocations(athleteId, isEdit);

      form.athlete_id.addEventListener('change', () => loadLocations(form.athlete_id.value, false));
      modal.querySelector('[data-add]').addEventListener('click', () => actsBox.insertAdjacentHTML('beforeend', activityRow(locs)));
      actsBox.addEventListener('click', (e) => { if (e.target.closest('[data-remove]')) e.target.closest('.activity-row').remove(); });
      modal.querySelectorAll('[data-mode]').forEach((tab) => tab.addEventListener('click', () => {
        mode = tab.dataset.mode;
        modal.querySelectorAll('[data-mode]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
        modal.querySelectorAll('[data-single]').forEach((el) => el.classList.toggle('hidden', mode !== 'single'));
        modal.querySelectorAll('[data-bulk]').forEach((el) => el.classList.toggle('hidden', mode !== 'bulk'));
      }));

      const payload = () => ({
        athlete_id: Number(form.athlete_id.value),
        filing_date: form.filing_date.value,
        overnight_location_id: Number(form.overnight_location_id.value),
        slot_start: form.slot_start.value,
        slot_location_id: Number(form.slot_location_id.value),
        notes: form.notes.value,
        activities: [...actsBox.querySelectorAll('.activity-row')].map((r) => ({
          activity_type: r.querySelector('[name=activity_type]').value,
          location_id: Number(r.querySelector('[name=location_id]').value),
          start_time: r.querySelector('[name=start_time]').value,
          end_time: r.querySelector('[name=end_time]').value,
          description: r.querySelector('[name=description]').value,
        })),
      });

      modal.querySelector('[data-save]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          let res;
          if (isEdit) {
            res = await api.put(`/api/filings/${existing.id}`, payload());
            toast('Whereabouts updated', 'Everyone viewing the board can see the change now.', 'green');
          } else if (mode === 'bulk') {
            const p = payload();
            res = await api.post('/api/filings/bulk', {
              ...p, from: form.from.value, to: form.to.value, overwrite: form.overwrite.checked,
              weekdays: [...form.querySelectorAll('[name=wd]:checked')].map((c) => Number(c.value)),
            });
            toast('Quarterly filing saved', `${res.created} days filed, ${res.updated} replaced, ${res.skipped} already filed`, 'green');
          } else {
            res = await api.post('/api/filings', payload());
            toast('Whereabouts filed', '', 'green');
          }
          (res.warnings || []).forEach((w) => toast('Check this filing', w.message, 'red'));
          close();
          if (onSaved) onSaved(res);
        } catch (err) {
          showErrors(modal, err);
        } finally {
          e.target.disabled = false;
        }
      });

      const withdraw = modal.querySelector('[data-withdraw]');
      if (withdraw) withdraw.addEventListener('click', async () => {
        if (!(await confirmDialog(`Withdraw the filing for ${fmtDate(existing.filing_date)}? The day will show as not filed.`, 'Withdraw filing'))) return;
        try {
          await api.del(`/api/filings/${existing.id}`);
          toast('Filing withdrawn', '', '');
          close();
          if (onSaved) onSaved({});
        } catch (err) { showErrors(modal, err); }
      });
    },
  });
}
