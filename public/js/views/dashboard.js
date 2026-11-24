// Overview: today's exceptions, quarterly deadlines, failure risk, the next
// competitions and travel, and recent changes.
import { api } from '../api.js';
import { esc, fmtDate, fmtShort, fmtDateTime, fmtUtc, riskTag, debounce } from '../ui.js';
import * as live from '../live.js';

export default async function dashboardView(root) {
  async function load() {
    const d = await api.get('/api/dashboard');
    const tz = live.getTimeZone();
    const b = d.board;
    const deadlineLine = (c) => {
      const left = c.inProgress ? `rest of quarter to ${fmtDate(c.quarter.end)}` : `due ${fmtDate(c.deadline)} (${c.daysToDeadline} days)`;
      const tone = c.inProgress ? 'bad' : c.daysToDeadline <= 21 ? 'warning' : 'info';
      return `<li><span class="grow"><strong>${esc(c.quarter.label)}</strong>, ${esc(left)}</span>
        ${c.incomplete ? `<span class="tag ${tone}">${c.incomplete} with gaps</span>` : '<span class="tag ok">All filed</span>'}</li>`;
    };

    const alerts = d.alerts.map((a) => {
      if (!a.filing) return `<li><span class="when" style="color:var(--red)">No filing</span><span class="grow"><a href="#/athletes/${a.athlete.id}">${esc(a.athlete.name)}</a> has no whereabouts for today</span></li>`;
      if (a.live.slotState === 'active') return `<li><span class="when" style="color:#a86f00">${esc(a.filing.slotStart)}</span><span class="grow"><a href="#/athletes/${a.athlete.id}">${esc(a.athlete.name)}</a> is in their slot at ${esc(a.filing.slot.label)}, ${esc(a.filing.slot.city)}</span><span class="tag live">In slot</span></li>`;
      return a.conflicts.map((c) => `<li><span class="when" style="color:var(--red)">Conflict</span><span class="grow"><a href="#/athletes/${a.athlete.id}">${esc(a.athlete.name)}</a>: ${esc(c.message)}</span></li>`).join('');
    }).join('');

    root.innerHTML = `
      <div class="page-head"><div><h1>Overview</h1><p class="lede">Today at a glance for ${esc(fmtDate(d.today))}.</p></div>
        <div class="actions"><a class="btn btn-primary" href="#/whereabouts">Open live board</a></div></div>
      <div class="strip">
        <div class="amber"><div class="n">${b.inSlotNow}</div><div class="l">In slot now</div></div>
        <div class="green"><div class="n">${b.filed}/${b.total}</div><div class="l">Filed for today</div></div>
        <div class="${b.missing ? 'red' : ''}"><div class="n">${b.missing}</div><div class="l">Not filed today</div></div>
        <div class="${b.conflicts ? 'red' : ''}"><div class="n">${b.conflicts}</div><div class="l">Conflicts today</div></div>
        <div><div class="n">${d.coverage.next.incomplete}</div><div class="l">With gaps in ${esc(d.coverage.next.quarter.label)}</div></div>
      </div>
      <div class="grid-2 section">
        <section class="panel"><div class="panel-head"><h2>Needs attention today</h2></div>
          <ul class="list">${alerts || '<li class="muted">Every athlete is filed and nothing clashes with travel or competitions.</li>'}</ul></section>
        <section class="panel"><div class="panel-head"><h2>Quarterly filing deadlines</h2></div>
          <ul class="list">${deadlineLine(d.coverage.current)}${deadlineLine(d.coverage.next)}</ul>
          <div class="panel-head" style="border-top:1px solid var(--rule)"><h2>Failure risk (12 months)</h2></div>
          <ul class="list">${d.atRisk.length ? d.atRisk.map((r) => `<li><span class="grow"><a href="#/athletes/${r.athlete.id}">${esc(r.athlete.name)}</a> <span class="muted">${esc(r.athlete.sport)}</span></span>${riskTag(r.failures)}</li>`).join('') : '<li class="muted">No recorded failures in the last 12 months.</li>'}</ul>
        </section>
      </div>
      <div class="grid-2 section">
        <section class="panel"><div class="panel-head"><h2>Competitions in the next 30 days</h2><span class="spacer"></span><a href="#/competitions" class="small">All competitions</a></div>
          <ul class="list">${d.competitions.length ? d.competitions.map((c) => `<li><span class="when">${esc(fmtShort(c.start_date))}</span><span class="grow"><strong>${esc(c.name)}</strong><br><span class="muted small">${esc(c.venue)}, ${esc(c.competition_location)}</span></span><span class="tag info">${c.entrants} athlete${c.entrants === 1 ? '' : 's'}</span></li>`).join('') : '<li class="muted">No competitions in the next 30 days.</li>'}</ul></section>
        <section class="panel"><div class="panel-head"><h2>Travel in the next 7 days</h2><span class="spacer"></span><a href="#/travel" class="small">All bookings</a></div>
          <ul class="list">${d.travel.length ? d.travel.map((t) => `<li><span class="when">${esc(fmtDateTime(t.depart_at))}</span><span class="grow"><strong>${esc(t.first_name)} ${esc(t.last_name)}</strong>, ${esc(t.travel_type.toLowerCase())} to ${esc(t.travel_booking_location)}<br><span class="muted small">${esc(t.booking_ref)} with ${esc(t.carrier || 'no carrier set')}</span></span></li>`).join('') : '<li class="muted">No travel booked for the next 7 days.</li>'}</ul></section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Recent changes</h2><span class="spacer"></span><a href="#/activity" class="small">Full audit log</a></div>
        <ul class="list">${d.activity.map((a) => `<li><span class="when" style="width:110px">${esc(fmtUtc(a.created_at, tz))}</span><span class="grow">${esc(a.summary)} <span class="muted">by ${esc(a.user_name || 'System')}</span></span></li>`).join('')}</ul></section>`;
  }

  await load();
  const refresh = debounce(() => load().catch(() => {}), 400);
  const offs = ['tick', 'activity', 'slot.started', 'slot.ended', 'day.changed'].map((t) => live.on(t, refresh));
  return () => offs.forEach((o) => o());
}
