// Live whereabouts board: every athlete's filed day on a 05:00–23:00 ruler,
// with a moving "now" line, live slot countdowns, conflicts and coverage.
import { api } from '../api.js';
import { esc, fmtDate, fmtShort, fmtDuration, fmtUtc, addDays, riskTag, debounce } from '../ui.js';
import * as live from '../live.js';
import { openFilingForm } from './filingForm.js';

const DAY_START = 5 * 60;
const DAY_SPAN = 18 * 60;
const pct = (min) => Math.max(0, Math.min(100, ((min - DAY_START) / DAY_SPAN) * 100));
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

export default async function whereaboutsView(root, { session }) {
  const st = {
    date: live.now().date,
    followToday: true,
    tab: 'board',
    quarter: 'current',
    filter: { q: '', sport: '', show: 'all' },
    expanded: new Set(),
    board: null,
    flash: new Set(),
  };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Live whereabouts</h1>
        <p class="lede">Where each athlete is filed to be, updated the moment anyone changes a filing.</p>
      </div>
      <div class="actions">${session.canEdit ? '<button class="btn btn-primary" data-new>File whereabouts</button>' : ''}</div>
    </div>
    <div class="strip" data-strip></div>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-tab="board">Day board</button>
      <button type="button" role="tab" aria-selected="false" data-tab="coverage">Quarter coverage</button>
    </div>
    <div class="split">
      <div>
        <section data-pane="board">
          <div class="board-controls">
            <div class="date-nav">
              <button class="icon-btn" data-day="-1" aria-label="Previous day">‹</button>
              <input type="date" data-date aria-label="Board date">
              <button class="icon-btn" data-day="1" aria-label="Next day">›</button>
              <button class="btn btn-sm" data-today>Today</button>
            </div>
            <span class="date-label" data-date-label></span>
            <div class="toolbar" style="margin-left:auto">
              <input type="search" placeholder="Search athletes" data-q aria-label="Search athletes">
              <select data-sport aria-label="Sport"><option value="">All sports</option></select>
              <select data-show aria-label="Show">
                <option value="all">Everyone</option>
                <option value="active">In slot now</option>
                <option value="missing">Not filed</option>
                <option value="conflicts">Conflicts</option>
                <option value="risk">Failure risk</option>
              </select>
            </div>
          </div>
          <div class="board" data-board></div>
        </section>
        <section data-pane="coverage" class="hidden">
          <div class="board-controls">
            <div class="toolbar">
              <select data-quarter aria-label="Quarter">
                <option value="current">Rest of this quarter</option>
                <option value="next">Next quarter</option>
              </select>
            </div>
          </div>
          <div data-coverage></div>
        </section>
      </div>
      <aside class="panel">
        <div class="panel-head"><h2>Live activity</h2></div>
        <ul class="feed" data-feed></ul>
      </aside>
    </div>`;

  const $ = (sel) => root.querySelector(sel);

  // ---------------- Board ---------------------------------------------
  async function loadBoard() {
    st.board = await api.get(`/api/whereabouts/live?date=${st.date}`);
    renderBoard();
  }

  function renderStrip() {
    const s = st.board.summary;
    $('[data-strip]').innerHTML = `
      <div class="amber"><div class="n">${s.inSlotNow}</div><div class="l">In 60-minute slot now</div></div>
      <div><div class="n">${s.upcomingNextHour}</div><div class="l">Slots opening within an hour</div></div>
      <div class="green"><div class="n">${s.filed}<span class="muted" style="font-size:16px"> of ${s.total}</span></div><div class="l">Filed for ${st.board.isToday ? 'today' : fmtShort(st.date)}</div></div>
      <div class="${s.missing ? 'red' : ''}"><div class="n">${s.missing}</div><div class="l">Not filed</div></div>
      <div class="${s.conflicts ? 'red' : ''}"><div class="n">${s.conflicts}</div><div class="l">Travel or competition conflicts</div></div>
      <div class="${s.atRisk ? 'red' : ''}"><div class="n">${s.atRisk}</div><div class="l">At high failure risk</div></div>`;
  }

  function visibleRows() {
    const f = st.filter;
    return st.board.athletes.filter((r) => {
      if (f.q && !`${r.athlete.name} ${r.athlete.code} ${r.athlete.sport}`.toLowerCase().includes(f.q.toLowerCase())) return false;
      if (f.sport && r.athlete.sport !== f.sport) return false;
      if (f.show === 'active') return r.live.slotState === 'active';
      if (f.show === 'missing') return !r.filing;
      if (f.show === 'conflicts') return r.conflicts.length > 0;
      if (f.show === 'risk') return r.failures.level !== 'ok';
      return true;
    });
  }

  function rulerHtml(r) {
    if (!r.filing) return '<div class="ruler"><div class="empty">No whereabouts filed</div></div>';
    const f = r.filing;
    const acts = f.activities.map((a) => {
      const l = pct(toMin(a.start));
      const w = pct(toMin(a.end)) - l;
      return `<div class="act ${esc(a.type)}" style="left:${l}%;width:${w}%" title="${esc(`${a.start}–${a.end} ${a.type}: ${a.location.label}`)}"></div>`;
    }).join('');
    const sl = pct(toMin(f.slotStart));
    const sw = pct(toMin(f.slotEnd)) - sl;
    const nowLine = st.board.isToday ? `<div class="now" data-now style="left:${pct(live.now().minutes)}%"></div>` : '';
    return `<div class="ruler">${acts}<div class="slot ${r.live.slotState}" style="left:${sl}%;width:${sw}%" title="${esc(`60-minute slot ${f.slotStart}–${f.slotEnd} at ${f.slot.label}`)}">${esc(f.slotStart)}</div>${nowLine}</div>`;
  }

  function nowHtml(r) {
    const L = r.live;
    if (!r.filing) {
      return `<div class="whereabout-now"><span class="place" style="color:var(--red)">Location unknown</span><span class="why">No filing for this day. File now to avoid a filing failure.</span></div>`;
    }
    let count = '';
    if (st.board.isToday && L.slotState === 'active') count = `<span class="countdown active" data-count="end" data-target="${toMin(r.filing.slotEnd)}">${fmtDuration(L.secondsRemaining)}</span> left in slot`;
    else if (st.board.isToday && L.slotState === 'upcoming') count = `Slot in <span class="countdown" data-count="start" data-target="${toMin(r.filing.slotStart)}">${fmtDuration(L.secondsToSlot)}</span>`;
    else if (L.slotState === 'completed') count = `Slot ${esc(r.filing.slotStart)}–${esc(r.filing.slotEnd)} done`;
    else count = `Slot ${esc(r.filing.slotStart)}–${esc(r.filing.slotEnd)}`;

    const loc = L.expected || L.fallback;
    const label = st.board.isToday ? (L.expected ? L.expected.label : `Unscheduled (overnight: ${L.fallback.label})`) : r.filing.slot.label;
    return `<div class="whereabout-now">
      <span class="place" title="${esc(loc ? `${loc.address}, ${loc.city}` : '')}">${esc(label)}${loc ? `<span class="muted" style="font-weight:400">, ${esc(loc.city)}</span>` : ''}</span>
      <span class="why">${st.board.isToday ? `${esc(L.expectedReason)}. ` : ''}${count}</span>
    </div>`;
  }

  function detailHtml(r) {
    const f = r.filing;
    const addr = (l) => l ? `<div class="addr"><strong>${esc(l.label)}</strong><br>${esc(l.address)}<br>${esc(l.city)}, ${esc(l.country)}${l.access ? `<br><span class="muted">${esc(l.access)}</span>` : ''}</div>` : '';
    const conflicts = r.conflicts.length
      ? `<ul>${r.conflicts.map((c) => `<li class="conflict">${esc(c.message)}</li>`).join('')}</ul>`
      : '<p class="muted small">No clashes with travel bookings or competitions.</p>';
    if (!f) {
      return `<div class="row-detail">
        <div><h4>Status</h4><p>No whereabouts filed for ${esc(fmtDate(st.date))}.</p></div>
        <div><h4>Cross-checks</h4>${conflicts}</div>
        <div><h4>Failure record</h4><p>${esc(r.failures.label)}</p></div>
        <div class="detail-actions">${session.canEdit ? `<button class="btn btn-primary btn-sm" data-file="${r.athlete.id}">File whereabouts</button>` : ''}
          <a class="btn btn-sm" href="#/athletes/${r.athlete.id}">Open profile</a></div>
      </div>`;
    }
    return `<div class="row-detail">
      <div><h4>60-minute slot, ${esc(f.slotStart)}–${esc(f.slotEnd)}</h4>${addr(f.slot)}</div>
      <div><h4>Overnight address</h4>${addr(f.overnight)}</div>
      <div><h4>Activities</h4>${f.activities.length ? `<ul>${f.activities.map((a) => `<li><span class="time">${esc(a.start)}–${esc(a.end)}</span> ${esc(a.type)} at ${esc(a.location.label)}</li>`).join('')}</ul>` : '<p class="muted small">None declared (rest day).</p>'}</div>
      <div><h4>Cross-checks</h4>${conflicts}</div>
      <div><h4>Filing record</h4><p class="small">Version ${f.version}, ${esc(f.source.toLowerCase())} filing<br>Last changed ${esc(fmtUtc(f.updatedAt, live.getTimeZone()))}${f.notes ? `<br>${esc(f.notes)}` : ''}</p></div>
      <div><h4>Failure record</h4><p class="small">${esc(r.failures.label)} in the last 12 months</p></div>
      <div class="detail-actions">${session.canEdit ? `<button class="btn btn-primary btn-sm" data-edit="${f.id}">Update filing</button>` : ''}
        <a class="btn btn-sm" href="#/athletes/${r.athlete.id}">Open profile</a></div>
    </div>`;
  }

  function renderBoard() {
    renderStrip();
    const sports = [...new Set(st.board.athletes.map((r) => r.athlete.sport))].sort();
    const sportSel = $('[data-sport]');
    if (sportSel.options.length !== sports.length + 1) {
      sportSel.innerHTML = `<option value="">All sports</option>${sports.map((s) => `<option>${esc(s)}</option>`).join('')}`;
      sportSel.value = st.filter.sport;
    }
    $('[data-date]').value = st.date;
    $('[data-date-label]').textContent = st.board.isToday ? `Today, ${fmtDate(st.date, false)}` : fmtDate(st.date);

    const hours = [];
    for (let h = 5; h <= 23; h += 2) hours.push(`<span style="left:${pct(h * 60)}%">${String(h).padStart(2, '0')}:00</span>`);
    const rows = visibleRows();
    $('[data-board]').innerHTML = `
      <div class="board-scale"><div>Athlete</div><div class="scale">${hours.join('')}</div><div>${st.board.isToday ? 'Expected location now' : 'Slot location'}</div></div>
      ${rows.length ? rows.map((r) => {
        const cls = [r.live.slotState === 'active' && st.board.isToday ? 'is-active' : '', !r.filing ? 'is-missing' : '', st.flash.has(r.athlete.id) ? 'flash' : ''].join(' ');
        const tags = [
          r.live.slotState === 'active' && st.board.isToday ? '<span class="tag live">In slot</span>' : '',
          r.conflicts.length ? `<span class="tag bad">${r.conflicts.length} conflict${r.conflicts.length > 1 ? 's' : ''}</span>` : '',
          r.failures.level !== 'ok' ? riskTag(r.failures) : '',
          r.athlete.status !== 'Active' ? `<span class="tag">${esc(r.athlete.status)}</span>` : '',
        ].join('');
        return `<div class="board-row ${cls}" data-row="${r.athlete.id}" tabindex="0" role="button" aria-expanded="${st.expanded.has(r.athlete.id)}">
          <div class="who"><strong>${esc(r.athlete.name)}</strong>
            <span class="meta">${esc(r.athlete.sport)}${r.athlete.discipline ? `, ${esc(r.athlete.discipline)}` : ''}, ${esc(r.athlete.pool)}</span>
            ${tags ? `<div class="tags">${tags}</div>` : ''}</div>
          ${rulerHtml(r)}
          ${nowHtml(r)}
          ${st.expanded.has(r.athlete.id) ? detailHtml(r) : ''}
        </div>`;
      }).join('') : '<div class="empty-state">No athletes match these filters.</div>'}
      <div class="legend">
        <span><i style="background:var(--cap)"></i>60-minute slot</span>
        <span><i style="background:var(--amber)"></i>Slot open now</span>
        <span><i style="background:#b5c2cf"></i>Training or gym</span>
        <span><i style="background:#7d63c9"></i>Competition</span>
        <span><i style="background:#57a3a8"></i>Medical</span>
        <span><i style="background:var(--red);width:2px"></i>Now</span>
      </div>`;
    st.flash.clear();
  }

  // Every second: move the now line and count down without refetching.
  function onSecond(n) {
    if (!st.board || !st.board.isToday || st.tab !== 'board') return;
    const left = `${pct(n.minutes + (n.seconds % 60) / 60)}%`;
    root.querySelectorAll('[data-now]').forEach((el) => { el.style.left = left; });
    let crossed = false;
    root.querySelectorAll('[data-count]').forEach((el) => {
      const secs = Number(el.dataset.target) * 60 - n.seconds;
      if (secs <= 0) crossed = true;
      el.textContent = fmtDuration(secs);
    });
    if (crossed) refresh();
  }

  // ---------------- Coverage ------------------------------------------
  async function loadCoverage() {
    const c = await api.get(`/api/whereabouts/coverage?quarter=${st.quarter}`);
    const urgency = c.inProgress ? (c.incomplete ? 'overdue' : '') : c.deadlinePassed ? 'overdue' : c.daysToDeadline <= 21 ? 'urgent' : '';
    const deadlineText = c.inProgress
      ? `Quarter under way. Showing the days from today to ${fmtDate(c.quarter.end)}; any gap must be filed now`
      : c.deadlinePassed
        ? `Deadline was ${fmtDate(c.deadline)}`
        : `Due ${fmtDate(c.deadline)}, ${c.daysToDeadline} day${c.daysToDeadline === 1 ? '' : 's'} left`;
    $('[data-coverage]').innerHTML = `
      <div class="deadline ${c.incomplete ? urgency : ''}">
        <strong>${esc(c.quarter.label)} filing</strong>
        <span>${esc(deadlineText)}.</span>
        <span>${c.complete} of ${c.athletes.length} athletes fully filed.</span>
      </div>
      <div class="panel"><div class="panel-body">
        ${c.athletes.map((a) => `
          <div class="coverage-row">
            <div><strong>${esc(a.athlete.name)}</strong><span class="sub muted">${esc(a.athlete.sport)}</span></div>
            <div>
              <div class="days" title="${esc(c.from)} to ${esc(c.quarter.end)}">${a.days.map((d) => `<b class="${d ? '' : 'miss'}"></b>`).join('')}</div>
              ${a.missingCount ? `<div class="small" style="color:var(--red);margin-top:4px">Missing: ${a.missingRanges.slice(0, 4).map((r) => (r.from === r.to ? fmtShort(r.from) : `${fmtShort(r.from)} to ${fmtShort(r.to)}`)).join(', ')}${a.missingRanges.length > 4 ? ` and ${a.missingRanges.length - 4} more gaps` : ''}</div>` : ''}
            </div>
            <div style="text-align:right">${a.complete ? '<span class="tag ok">Complete</span>' : `<span class="num">${a.pct}%</span><span class="sub muted">${a.missingCount} days to file</span>`}</div>
          </div>`).join('')}
      </div></div>`;
  }

  // ---------------- Feed ----------------------------------------------
  function feedItem(a, isNew) {
    return `<li class="${isNew ? 'new' : ''}"><time>${esc(fmtUtc(a.created_at, live.getTimeZone()))}, ${esc(a.user_name || 'System')}</time>${esc(a.summary)}</li>`;
  }
  async function loadFeed() {
    const items = await api.get('/api/activity?limit=30');
    $('[data-feed]').innerHTML = items.length ? items.map((a) => feedItem(a)).join('') : '<li class="muted">Changes to filings will appear here as they happen.</li>';
  }

  // ---------------- Wiring --------------------------------------------
  const refresh = debounce(() => (st.tab === 'board' ? loadBoard() : loadCoverage()).catch(() => {}), 250);

  function setDate(d) {
    st.date = d;
    st.followToday = d === live.now().date;
    st.expanded.clear();
    loadBoard();
  }

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-new]')) return openFilingForm({ date: st.date, onSaved: refresh });
    if (t.closest('[data-file]')) return openFilingForm({ athleteId: Number(t.closest('[data-file]').dataset.file), date: st.date, onSaved: refresh });
    if (t.closest('[data-edit]')) return openFilingForm({ filingId: Number(t.closest('[data-edit]').dataset.edit), onSaved: refresh });
    if (t.closest('[data-day]')) return setDate(addDays(st.date, Number(t.closest('[data-day]').dataset.day)));
    if (t.closest('[data-today]')) return setDate(live.now().date);
    if (t.closest('[data-tab]')) {
      st.tab = t.closest('[data-tab]').dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === st.tab)));
      $('[data-pane="board"]').classList.toggle('hidden', st.tab !== 'board');
      $('[data-pane="coverage"]').classList.toggle('hidden', st.tab !== 'coverage');
      return refresh();
    }
    if (t.closest('a, button, .row-detail')) return;
    const row = t.closest('[data-row]');
    if (row) {
      const id = Number(row.dataset.row);
      if (st.expanded.has(id)) st.expanded.delete(id); else st.expanded.add(id);
      renderBoard();
    }
  });
  root.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('[data-row]');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });
  $('[data-date]').addEventListener('change', (e) => e.target.value && setDate(e.target.value));
  $('[data-q]').addEventListener('input', debounce((e) => { st.filter.q = e.target.value; renderBoard(); }, 150));
  $('[data-sport]').addEventListener('change', (e) => { st.filter.sport = e.target.value; renderBoard(); });
  $('[data-show]').addEventListener('change', (e) => { st.filter.show = e.target.value; renderBoard(); });
  $('[data-quarter]').addEventListener('change', (e) => { st.quarter = e.target.value; loadCoverage(); });

  const offs = [
    live.on('second', onSecond),
    live.on('tick', refresh),
    live.on('activity', (a) => {
      const feed = $('[data-feed]');
      if (feed.querySelector('.muted')) feed.innerHTML = '';
      feed.insertAdjacentHTML('afterbegin', feedItem(a, true));
      while (feed.children.length > 50) feed.lastChild.remove();
    }),
    live.on('day.changed', (d) => { if (st.followToday) setDate(d.date); }),
  ];
  for (const type of ['filing.created', 'filing.updated', 'filing.deleted', 'filing.bulk', 'slot.started', 'slot.ended',
    'location.changed', 'travel.changed', 'competition.changed', 'failure.changed', 'athlete.changed']) {
    offs.push(live.on(type, (d) => { if (d && d.athleteId) st.flash.add(d.athleteId); refresh(); }));
  }

  await Promise.all([loadBoard(), loadFeed()]);
  return () => offs.forEach((off) => off());
}
