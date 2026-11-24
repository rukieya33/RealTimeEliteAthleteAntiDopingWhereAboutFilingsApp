// UI helpers: escaping, formatting, modals, toasts, form utilities.

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tagged template that escapes interpolated values unless wrapped in raw(). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    let v = values[i - 1];
    if (Array.isArray(v)) v = v.map((x) => (x && x.__raw !== undefined ? x.__raw : esc(x))).join('');
    else if (v && v.__raw !== undefined) v = v.__raw;
    else v = esc(v);
    return out + v + s;
  });
}
export const raw = (s) => ({ __raw: String(s) });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtDate(d, withDay = true) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return `${withDay ? `${DAYS[dow]} ` : ''}${day} ${MONTHS[m - 1]} ${y}`;
}
export function fmtShort(d) {
  if (!d) return '';
  const [, m, day] = d.slice(0, 10).split('-').map(Number);
  return `${day} ${MONTHS[m - 1]}`;
}
export function fmtDateTime(dt) {
  if (!dt) return '';
  return `${fmtShort(dt)} ${dt.slice(11, 16)}`;
}
/** UTC timestamps from the server (audit, submissions) shown in the agency zone. */
export function fmtUtc(ts, tz) {
  if (!ts) return '';
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
export function addDays(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day + n));
  return dt.toISOString().slice(0, 10);
}
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
export function initials(name) {
  return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
export function riskTag(f) {
  if (!f) return '';
  const text = { ok: 'No failures', warning: `${f.count} failure`, high: `${f.count} failures`, critical: `${f.count} failures` }[f.level];
  return `<span class="tag ${f.level}" title="${esc(f.label)}">${esc(text)}</span>`;
}

// ---- Toasts -------------------------------------------------------------
export function toast(title, body = '', tone = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = `<strong>${esc(title)}</strong>${body ? esc(body) : ''}`;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), 6000);
}

// ---- Modal --------------------------------------------------------------
export function openModal({ title, body, footer = '', wide = false, onMount, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-head"><h2 id="modal-title">${esc(title)}</h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  const previous = document.activeElement;
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    if (onClose) onClose();
    document.removeEventListener('keydown', onKey);
    if (previous && previous.focus) previous.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  const first = overlay.querySelector('input, select, textarea, button:not([data-close])');
  if (first) first.focus();
  if (onMount) onMount(overlay.querySelector('.modal'), close);
  return close;
}

export function confirmDialog(message, actionLabel = 'Confirm') {
  return new Promise((resolve) => {
    let ok = false;
    const close = openModal({
      title: 'Please confirm',
      body: `<p>${esc(message)}</p>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-ok>${esc(actionLabel)}</button>`,
      onMount: (m) => m.querySelector('[data-ok]').addEventListener('click', () => { ok = true; close(); }),
      onClose: () => resolve(ok),
    });
  });
}

export function showErrors(container, err) {
  const box = container.querySelector('.errors');
  if (!box) return toast('Something went wrong', err.message, 'red');
  box.innerHTML = `${esc(err.message)}${err.details && err.details.length ? `<ul>${err.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`;
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'nearest' });
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

export function options(list, selected, { value = 'id', label = 'label', blank } = {}) {
  const opts = blank !== undefined ? [`<option value="">${esc(blank)}</option>`] : [];
  for (const item of list) {
    const v = typeof item === 'object' ? item[value] : item;
    const l = typeof item === 'object' ? (typeof label === 'function' ? label(item) : item[label]) : item;
    opts.push(`<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`);
  }
  return opts.join('');
}

export function debounce(fn, ms) {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
}
