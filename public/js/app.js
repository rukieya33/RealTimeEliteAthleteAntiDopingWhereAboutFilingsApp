// Entry point: session check, live connection and hash router.
import { api } from './api.js';
import * as live from './live.js';
import { toast } from './ui.js';
import whereabouts from './views/whereabouts.js';
import dashboard from './views/dashboard.js';
import athletes from './views/athletes.js';
import travel from './views/travel.js';
import competitions from './views/competitions.js';
import failures from './views/failures.js';
import activity from './views/activity.js';

const routes = { whereabouts, dashboard, athletes, travel, competitions, failures, activity };
export const session = { user: null, meta: null };

let cleanup = null;

async function render() {
  const [name, ...params] = location.hash.replace(/^#\/?/, '').split('/');
  const route = routes[name] ? name : 'whereabouts';
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (cleanup) { cleanup(); cleanup = null; }
  const view = document.getElementById('view');
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    cleanup = (await routes[route](view, { params, session })) || null;
  } catch (err) {
    if (err.status !== 401) {
      view.innerHTML = '<div class="errors">This page could not be loaded. Check the server and database are running, then refresh.</div>';
      toast('Could not load page', err.message, 'red');
    }
  }
}

async function start() {
  try {
    session.user = await api.get('/api/auth/me');
  } catch {
    return; // api.js redirects to /login
  }
  session.meta = await api.get('/api/meta');
  session.canEdit = ['admin', 'manager'].includes(session.user.role);
  live.setTimeZone(session.meta.timeZone);
  live.setUser(session.user.name);
  document.getElementById('app-name').textContent = session.meta.appName;
  document.getElementById('user-name').textContent = `${session.user.name} (${session.user.role})`;
  document.getElementById('logout').addEventListener('click', async () => {
    await api.post('/api/auth/logout');
    location.href = '/login';
  });
  live.startClock();
  live.connect();
  window.addEventListener('hashchange', render);
  render();
}

start();
