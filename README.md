# Pines Budget Sandbox

A private budgeting sandbox for The Pines Resort: load actuals exported from Sage Intacct, build department budgets with
drivers, run what-if scenarios, and see the P&L and cash. It never signs in to Sage; it only reads files you upload.

## Run it

```
npm install
npm run dev        # http://localhost:5000
```

Set a secret named `APP_PASSWORD` first; nobody can sign in without it. With `DATABASE_URL` set (Replit PostgreSQL) the app
uses that database; without it, it stores data in an embedded Postgres under `.pgdata/`. Tables are created at start and the
seed files load on first run, so there is no migration step.

| Command | What it does |
| --- | --- |
| `npm run dev` | API and screens on one port (5000, or `PORT`) |
| `npm run build` then `npm start` | Production mode |
| `npm run seed` | Reload `/seed` (safe to repeat) |
| `npm test` | 27 checks: engine, Sage parser, seed, export, re-import |

## Where things are

| Path | What |
| --- | --- |
| `shared/calc.ts` | **All budget math.** Screens, Excel export and tests import it. |
| `shared/gl.ts` | Sage General Ledger CSV parser and tie-out |
| `server/schema.sql` | Database tables (runs at every start, safe to repeat) |
| `server/routes.ts` | Every `/api` route |
| `server/seed.ts`, `server/workbook.ts`, `server/excel.ts` | Seed loader, budget workbook import, Excel export |
| `client/src/pages/` | One file per screen |
| `seed/` | Reference CSVs (see `seed/README.md`) |

## Driver rules (in `shared/calc.ts`)

Typed and Fixed use the typed months. % of Revenue = rate x the department's revenue. % of Wages = rate x the department's
wage-base lines (6003 Staff Wages). CPOR = rate x occupied rooms. CPC = rate x covers. Growth over last year = same month
last year x (1 + rate). FTE = count x hours x hourly rate. Rooms sold x ADR and Covers x check drive revenue from the
Drivers page. A manual override on a month wins over the driver. Order inside a department: revenue, then wage base, then
every other cost. Levers apply to a line before the lines that depend on it.

See `REPLIT_HANDOFF.md` for the Replit steps and what has and has not been verified.
