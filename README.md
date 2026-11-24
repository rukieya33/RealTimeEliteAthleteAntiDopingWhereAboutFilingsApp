# Real-Time Elite Athlete Anti-Doping Whereabouts Filings

A web app that lets a sport management agency file and monitor anti-doping whereabouts for its elite athletes, in real time.

Built with **Node.js, Express, MySQL, HTML, CSS and vanilla JavaScript**. No front-end framework or build step is needed.

> **Placeholder data.** The athletes, addresses, competition locations and travel booking locations in `db/data/` are fictional. Load the agency's own athlete table with the CSV import (see below).

## What it does

**Live whereabouts board** (the main page)
- Shows every athlete's filed day on a 05:00–23:00 ruler, with a red "now" line that moves in real time.
- Highlights each 60-minute testing slot. While a slot is open it turns amber and counts down.
- Shows where each athlete is expected to be *right now*: their slot location, a declared activity, or their overnight address.
- Flags athletes with no filing for the day, as a filing failure risk.
- Cross-checks filings against **competition locations** and **travel booking locations**. For example: "Entered in Marrowby Indoor Grand Prix in Marrowby, but the filing places the athlete in Kestrelford."
- Updates instantly for everyone. Any change made by any user is pushed to every open browser over Server-Sent Events, and a live activity feed shows who changed what.
- Has a **quarter coverage** view: one square per day for each athlete, showing gaps for the rest of the current quarter and for next quarter, against the quarterly filing deadline.

**Filing**
- File one day, or use **bulk quarterly filing** to apply one template across a date range and chosen weekdays.
- Locations are restricted to each athlete's **allowed locations**.
- The 60-minute slot is validated to fall between 05:00 and 23:00.
- Same-day updates are versioned. Past filings can only be corrected by an administrator.

**Also included**
- Overview dashboard: today's exceptions, deadlines, failure risk, the next 30 days of competitions and the next 7 days of travel.
- Athlete profiles with allowed-location management, travel bookings, competitions and failures.
- Travel bookings and competitions, with athlete entries.
- Whereabouts failures (filing failures and missed tests), with a rolling 12-month risk count (3 = potential rule violation; configurable).
- Full audit log.
- Sign-in with three roles: **admin** (everything), **manager** (file and edit), **viewer** (read only).

## Requirements

- Node.js 18 or later
- MySQL 8 (MariaDB 10.6+ also works)

## Setup

```bash
git clone https://github.com/rukieya33/RealTimeEliteAthleteAntiDopingWhereAboutFilingsApp.git
cd RealTimeEliteAthleteAntiDopingWhereAboutFilingsApp
npm install
cp .env.example .env          # then edit DB_* and JWT_SECRET
```

Create a MySQL user for the app (once):

```sql
CREATE USER 'whereabouts_app'@'localhost' IDENTIFIED BY 'change_me';
GRANT ALL ON athlete_whereabouts.* TO 'whereabouts_app'@'localhost';
```

Create the tables and load the data, then start the server:

```bash
npm run db:setup      # applies db/schema.sql and seeds data (drops existing tables!)
npm start             # or: npm run dev  (restarts on file changes)
```

Open http://localhost:3000 and sign in:

| Role | Email | Password |
|---|---|---|
| Admin | admin@agency.test | ChangeMe123! (set in `.env`) |
| Manager | manager@agency.test | Demo1234! |
| Viewer | viewer@agency.test | Demo1234! |

Change these passwords before using real data.

The seed generates dates relative to the day you run it. The board is therefore always current: filings run from four weeks ago to the end of next quarter, with deliberate gaps and conflicts so the alerts have something to show. Re-run `npm run db:seed` at any time to reset.

## Loading the agency's athlete table

Save the athlete table as CSV with these columns (header names are matched loosely):

`athlete_code, first_name, last_name, gender, date_of_birth, nationality, sport, discipline, testing_pool, email, phone, agent_name, status, allowed_locations`

List `allowed_locations` separated by semicolons, each written as `Label | Address | City | Country | Type`.
A template is in `db/data/athletes-import-template.csv`.

Import it either:
- in the app: **Athletes → Import from CSV** (admin only), or
- from the command line: `npm run import:athletes -- path/to/athletes.csv`

Athletes are matched on `athlete_code`, so re-importing updates athletes rather than duplicating them.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `APP_TZ` | `Europe/London` | Time zone that "now", today and slots are evaluated in |
| `QUARTERLY_DEADLINE_DAY` | `15` | Day of the month before each quarter by which the quarter must be filed |
| `FAILURE_WINDOW_MONTHS` | `12` | Rolling window for counting whereabouts failures |
| `FAILURE_THRESHOLD` | `3` | Failures in the window that flag a potential rule violation |
| `LIVE_TICK_SECONDS` | `30` | How often the server pushes a live refresh and announces slots opening and closing |

## Project structure

```
server.js                 Express app, security headers, live slot ticker
src/config/               env and MySQL pool
src/middleware/           JWT cookie auth, roles, error handling
src/services/compliance.js  live slot state, expected location, conflicts, coverage, risk
src/services/realtime.js    Server-Sent Events hub
src/services/audit.js       audit log + live activity feed
src/services/importer.js    CSV athlete import
src/routes/               REST API
db/schema.sql             MySQL schema
db/data/                  placeholder athletes, competitions, CSV template
scripts/                  init-db, seed, import-athletes
public/                   front end (HTML, CSS, ES modules)
tests/                    unit tests (npm test)
```

## API overview

All endpoints except `/api/auth/login` and `/api/health` require sign-in.

| Method | Path | |
|---|---|---|
| POST | `/api/auth/login`, `/api/auth/logout` | Session cookie |
| GET | `/api/whereabouts/live?date=YYYY-MM-DD` | Live board for a day |
| GET | `/api/whereabouts/coverage?quarter=current\|next` | Quarter coverage |
| GET | `/api/dashboard` | Overview data |
| GET | `/api/stream` | Server-Sent Events (real-time updates) |
| GET/POST | `/api/filings`, `/api/filings/bulk` | List and create filings |
| GET/PUT/DELETE | `/api/filings/:id` | Read, update, withdraw (future only) |
| GET/POST/PUT/DELETE | `/api/athletes`, `/api/athletes/:id` | Athletes |
| GET/POST | `/api/athletes/:id/locations` | Allowed locations |
| PUT/DELETE | `/api/locations/:id` | Edit or remove a location (deactivates it if already used) |
| GET/POST/PUT/DELETE | `/api/travel` | Travel bookings |
| GET/POST/PUT/DELETE | `/api/competitions`, `/api/competitions/:id/entries` | Competitions and entries |
| GET/POST/PUT | `/api/failures` | Whereabouts failures |
| GET | `/api/activity` | Audit log |
| POST | `/api/import/athletes` | CSV import (admin) |

## Note on official systems

This app is the agency's own tool for planning, checking and monitoring whereabouts. It does not submit filings to any anti-doping organisation's official system. Athletes and agencies must still file through the system their anti-doping organisation requires.
