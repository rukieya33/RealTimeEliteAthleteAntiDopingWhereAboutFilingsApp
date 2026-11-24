// Full audit log: every change, who made it and when. New entries stream in live.
import { api } from '../api.js';
import { esc, fmtUtc } from '../ui.js';
import * as live from '../live.js';

export default async function activityView(root) {
  const tz = live.getTimeZone();
  const row = (a, isNew) => `<tr class="${isNew ? 'board-row flash' : ''}" style="display:table-row">
    <td class="num" style="white-space:nowrap">${esc(fmtUtc(a.created_at, tz))}</td><td>${esc(a.user_name || 'System')}</td>
    <td>${esc(a.action)}</td><td>${esc(a.entity)}</td><td>${esc(a.summary)}</td></tr>`;
  const items = await api.get('/api/activity?limit=200');
  root.innerHTML = `
    <div class="page-head"><div><h1>Audit log</h1><p class="lede">Every change to filings, athletes, locations, travel and competitions. New entries appear as they happen.</p></div></div>
    <div class="panel table-wrap"><table><thead><tr><th>When</th><th>By</th><th>Action</th><th>Record</th><th>Change</th></tr></thead>
    <tbody data-body>${items.map((a) => row(a)).join('')}</tbody></table></div>`;
  return live.on('activity', (a) => root.querySelector('[data-body]').insertAdjacentHTML('afterbegin', row(a, true)));
}
