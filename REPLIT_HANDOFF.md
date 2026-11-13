# Replit hand-off

The app is already built and tested. Replit only has to install it, give it a database and a password, and run it.
Grok's 11 build prompts are **not** needed; pasting them would make Agent rebuild what is here and charge for it.

## What you do (about 10 minutes)

1. **Create the Repl.** Replit > Create App > *Import code or design* > upload this zip (or import the GitHub repo if it was pushed there). Keep it **Private**.
2. **Add the password.** Tools > Secrets > add `APP_PASSWORD` with a long password. Nobody can sign in until it exists.
3. **Add the database.** Tools > Database > create a PostgreSQL database. This sets `DATABASE_URL` by itself.
4. **Run it.** Press Run. The first start creates the tables and loads the seed files.
5. **Open it in its own browser tab** (the "open in new tab" icon on the preview) and sign in.
6. **Load the real data** (see below).

### Cheapest route: no Agent at all

If Run does not start it, open the Shell tab and type:

```
npm install
npm run dev
```

That is the whole setup. `npm test` should report 27 passed, 1 skipped.

### If you would rather have Agent do it

Paste this one prompt. It is written to keep Agent from rebuilding anything.

```
This project is a finished, tested app called Pines Budget Sandbox (React + Vite + TypeScript, Express, PostgreSQL). Do NOT rebuild, restructure, restyle or "improve" it, and do not add Drizzle, Tailwind or any new dependency.

Your whole job:
1. Run npm install.
2. Make sure a Replit PostgreSQL database is attached so DATABASE_URL is set. Do not run migrations: server/schema.sql creates the tables at start, and the seed files load on first run.
3. Confirm the secret APP_PASSWORD exists. If it does not, stop and ask me to add it. Never print it, and never set ALLOW_NO_PASSWORD.
4. Make the Run button execute: npm run dev. The server listens on 0.0.0.0 and the PORT variable (default 5000). Fix the .replit file only if Run or the preview does not work.
5. Run npm test and tell me the result. Expected: 27 passed, 1 skipped.
6. Open the app, sign in, and confirm the Dashboard shows numbers.

Rules: read README.md and REPLIT_HANDOFF.md first. Do not edit shared/calc.ts (all the budget math) or the tests. If something fails, show me the exact error and the smallest fix before changing code. Keep the Repl private. Stop when the six steps are done.
```

## Loading the real data

The app starts on a small **made-up sample** (the top bar says SAMPLE DATA) because the real files were not available when it was built.

1. **Seed files.** Get the CSVs from `/workspace/budget-sandbox/` on ATLAS's computer and drag them into the `seed/` folder in Replit:
   `departments.csv`, `entities.csv`, `chart_of_accounts.csv`, `budget_lines_template.csv`, `drivers_hms_monthly_2025_2026.csv`, `drivers_lightspeed_covers_2025_2026.csv`.
   Then in the app: **Imports > Reload seed files**. It should report 277 accounts, 41 departments and 424 lines on 28 tabs.
2. **Your budget workbook.** **Imports > Budget workbook** > `2026_Budget_from_Nick.xlsx` (or the 2027 draft). It shows a tie-out against the file's own Summary P&L tab. Targets from the kit: 2026 revenue $16,809,005 and net income $969,444; 2027 draft v3 revenue $17,513,327 and net income $31,177.
3. **Sage actuals.** Ask Controller for the General Ledger report (accounts 4000-9999, posted only, accrual, all locations, Jan 1 2025 to the latest month-end, CSV) and its "Created on" time. **Imports > Sage General Ledger export**. Paste the expected totals to tie out, for example `2026-10, 1390209.21, 34473.19` for the 11/12/2026 1:07 PM pull.

## What is built (Grok's prompts 1 to 11, plus follow-ups B, C, D)

| Area | Where in the app |
| --- | --- |
| Password gate, one shared password, name for the change log | Sign-in |
| Seed loader and starter budget | Imports > Reload seed files |
| Sage GL import: preview, unknown codes block the save, tie-out to the cent, "Created on" required, latest import wins per month | Imports |
| Actuals by month or YTD, by department, with a "No department" row | Actuals |
| Department grids with drivers, overrides, add / delete a line, copy last year's actuals, spread a yearly total | Budget |
| Summary P&L (your layout) and Sage layout; month / quarter / year; entity filter; variance vs actuals and vs last year; print | P&L |
| Tiles, revenue and net income chart, profit by department, lowest-profit month, top 10 changes vs last year | Dashboard |
| Occupancy, ADR, RevPAR, covers, average check, last-year reference, growth %, fill from last year's shape | Drivers |
| Create, copy, rename, parent, lock, unlock, snapshot | Scenarios |
| Levers with on/off, six presets, lines hit and net income effect per lever | Scenarios |
| 2 to 4 scenarios side by side, by month, "what changed" over $5,000, sensitivity table | Compare |
| Cash rows from the workbook, TOT row, notes, lowest-cash alert, CSV import | Cash Flow |
| Excel export with live formulas, CSV export | Top bar |
| Change log, normalizations, settings | Change Log, Settings |
| Open-period banner and "two imports differ by more than $10,000" banner | Dashboard, Actuals, P&L |

Not built, on purpose: anything that signs in to Sage, the "P&L By Department" importer (a stub explains why), Sage auto-refresh, HMS feed, per-person logins.

## What was verified, and what was not

Verified here:
- 27 automated tests pass, including the workbook example: 25.8403536105498 x 1,167.9 = 30,178.95; commissions 0.9% x 242,749.17 = 2,184.74; a +3% wage lever lifts overtime, PTO and payroll taxes by 3%; a switched-off lever changes nothing; January 2025 occupancy 1,417 / 3,286 = 43.12%.
- The exported workbook was recalculated from scratch in LibreOffice with every saved value wiped; all 33 Summary P&L rows matched the app.
- Exporting a scenario and importing that file back ties out on revenue, EBITDA and net income.
- Every screen was opened in a browser with no errors; editing, levers, locking and reload were exercised.

Not verified, because the files were not available:
- **The real seed CSVs.** The loader follows the column names you sent. The summary-row codes for overhead rows were guessed from the kit (ROOMS, F&B, OTHER_OPERATED, MISC_INCOME, NONOP_INCOME are confirmed); anything unrecognised falls back to the department's own row.
- **Your real budget workbook.** The importer was only tested on the app's own export, which uses the same columns. If a driver line does not recalculate to the workbook's number, the workbook's number is kept as an orange override and listed, so the totals still tie.
- **A real Sage GL file.** The parser was tested on a made-up file in the documented format. The Department and Location columns accept `20`, `20--Rooms` or `20 - Rooms`.
- **Replit itself.** The app ran here on Node 22 with an embedded Postgres. `.replit` is a best guess at Replit's current format.
- The overtime check lands at 703.44 with the 2.3309% the kit prints; the kit's 703.46 needs the unrounded rate from the real CSV.

## Where this differs from Grok's kit

- **Engine and schema are new.** Grok's `calc.ts` and `schema.sql` did not load on the page, so both were written to the kit's rules. If you get Grok's `calc.ts`, compare it against `shared/calc.ts` before swapping anything.
- **No Drizzle, Tailwind or shadcn.** Plain SQL and plain CSS: fewer moving parts for Replit to install or break.
- **Occupancy lever is in points** ("+2 points"), matching the sensitivity table. Typed room revenue (4001 + 4002) moves with rooms sold when it is on.
- **"Food cost +2 points"** adds 2 points of department revenue once per department, on accounts 5184-5196.
- **A broad % lever does not hit derived lines twice** (a department-wide +5% on costs lifts overtime by 5%, not 10.25%).
- **Normalizations start switched off**, because the kit gives rounded amounts (about -$188K, $178K, -$71.7K) and no account for the asset-sale gain.
- **Unknown codes in a Sage file block the save**, as specified, with an explicit "add them and save anyway" button beside it.

## Keeping Replit cost down

- Run from the Shell instead of Agent whenever the change is small.
- Skip Deploy until someone other than you needs it; the workspace URL works while the Repl is awake. If you do deploy, use one instance (import previews are held in memory).
- When you do want a change from Agent, name the file: for example "in client/src/pages/Budget.tsx, add ...". The table above tells you which file.
