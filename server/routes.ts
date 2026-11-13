// Every /api route. All of them sit behind the login gate in index.ts.
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import Papa from 'papaparse';
import { q, tx, insertMany } from './db';
import { runSeed, prefillStats } from './seed';
import { loadBundle, copyScenario, assertUnlocked, audit, actualsBetween, getSettings, HttpError } from './scenario';
import { buildWorkbook, buildCsv } from './excel';
import { importWorkbook } from './workbook';
import { parseSageGL, validateGL, parseExpected, tieOut, parseMoney, type GLParse } from '../shared/gl';
import { ymOf, CASH_ROWS } from '../shared/calc';

export const api = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
type H = (req: express.Request, res: express.Response) => Promise<any>;
const h = (fn: H): express.RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const who = (req: express.Request) => (req as any).who as string;
const int = (v: any) => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, 'Bad id'); return n; };
const numOrNull = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------- reference data ----------
api.get('/ref', h(async (_req, res) => {
  const [entities, departments, accounts, scenarios, settings, statReference] = await Promise.all([
    q('SELECT * FROM entities ORDER BY entity_id'),
    q('SELECT * FROM departments ORDER BY sort_order, dept_id'),
    q('SELECT * FROM accounts ORDER BY account'),
    q(`SELECT s.*, (SELECT count(*)::int FROM budget_lines b WHERE b.scenario_id = s.id) AS line_count FROM scenarios s ORDER BY s.id`),
    getSettings(),
    q('SELECT dept_id, ym, key, value, source FROM stat_reference ORDER BY ym'),
  ]);
  res.json({ entities, departments, accounts, scenarios, settings, statReference });
}));
api.put('/settings', h(async (req, res) => {
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (!['room_count', 'fiscal_year', 'default_entity', 'rooms_dept', 'room_rev_accounts'].includes(k)) continue;
    const [old] = await q('SELECT value FROM settings WHERE key=$1', [k]);
    await q(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);
    await audit(q, who(req), null, `setting:${k}`, old?.value, v);
  }
  res.json(await getSettings());
}));
api.post('/seed', h(async (_req, res) => res.json({ report: await runSeed(() => {}) })));

// ---------- scenarios ----------
api.post('/scenarios', h(async (req, res) => {
  const { name, copyFrom, kind, fiscalYear } = req.body ?? {};
  if (!name?.trim()) throw new HttpError(400, 'Give the scenario a name');
  let id: number;
  if (copyFrom) id = await copyScenario(int(copyFrom), name.trim(), { kind, fiscalYear: fiscalYear ? int(fiscalYear) : undefined });
  else {
    const fy = fiscalYear ? int(fiscalYear) : Number((await getSettings()).fiscal_year) || 2027;
    [{ id }] = await q(`INSERT INTO scenarios (name, kind, fiscal_year) VALUES ($1,$2,$3) RETURNING id`, [name.trim(), kind || 'BUDGET', fy]);
    await prefillStats(q, id, fy);
  }
  await audit(q, who(req), id, 'scenario:create', null, name.trim(), { detail: copyFrom ? `copy of #${copyFrom}` : 'empty' });
  res.json({ id });
}));
api.post('/scenarios/:id/snapshot', h(async (req, res) => {
  const [s] = await q('SELECT name FROM scenarios WHERE id=$1', [int(req.params.id)]);
  if (!s) throw new HttpError(404, 'Scenario not found');
  const name = `${s.name} - ${new Date().toISOString().slice(0, 10)}`;
  const id = await copyScenario(int(req.params.id), name);
  await q(`UPDATE scenarios SET status='LOCKED', locked_by=$1, locked_at=now() WHERE id=$2`, [who(req), id]);
  await audit(q, who(req), id, 'scenario:snapshot', null, name);
  res.json({ id, name });
}));
api.patch('/scenarios/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const [s] = await q('SELECT * FROM scenarios WHERE id=$1', [id]);
  if (!s) throw new HttpError(404, 'Scenario not found');
  const b = req.body ?? {};
  if (b.status === 'LOCKED' && s.status !== 'LOCKED') {
    await q(`UPDATE scenarios SET status='LOCKED', locked_by=$1, locked_at=now() WHERE id=$2`, [who(req), id]);
    await audit(q, who(req), id, 'scenario:lock', 'DRAFT', 'LOCKED');
  } else if (b.status === 'DRAFT' && s.status === 'LOCKED') {
    await q(`UPDATE scenarios SET status='DRAFT', locked_by=NULL, locked_at=NULL WHERE id=$1`, [id]);
    await audit(q, who(req), id, 'scenario:unlock', 'LOCKED', 'DRAFT');
  }
  if (b.name !== undefined || b.kind !== undefined || b.parent_id !== undefined || b.notes !== undefined) {
    if (s.status === 'LOCKED' && b.status !== 'DRAFT') throw new HttpError(423, 'This scenario is locked.');
    await q(`UPDATE scenarios SET name=$1, kind=$2, parent_id=$3, notes=$4 WHERE id=$5`,
      [b.name?.trim() || s.name, b.kind || s.kind, b.parent_id === undefined ? s.parent_id : b.parent_id || null, b.notes ?? s.notes, id]);
    await audit(q, who(req), id, 'scenario:name', s.name, b.name?.trim() || s.name);
  }
  res.json({ ok: true });
}));
api.delete('/scenarios/:id', h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  const [s] = await q('SELECT name FROM scenarios WHERE id=$1', [id]);
  await q('DELETE FROM scenarios WHERE id=$1', [id]);
  await audit(q, who(req), id, 'scenario:delete', s?.name, null);
  res.json({ ok: true });
}));
api.get('/scenarios/:id/bundle', h(async (req, res) => res.json(await loadBundle(int(req.params.id)))));

// ---------- budget lines and cells ----------
api.post('/scenarios/:id/lines', h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  const b = req.body ?? {};
  const [sc] = await q('SELECT fiscal_year FROM scenarios WHERE id=$1', [id]);
  const [acct] = await q('SELECT account, name FROM accounts WHERE account=$1', [String(b.account)]);
  if (!acct) throw new HttpError(400, 'Pick an account from the chart of accounts');
  const [dept] = await q('SELECT dept_id FROM departments WHERE dept_id=$1', [String(b.deptId)]);
  if (!dept) throw new HttpError(400, 'Unknown department');
  const kind = acct.account >= '4000' && acct.account <= '4999' ? 'REVENUE' : 'COST';
  const [{ so }] = await q('SELECT coalesce(max(sort_order),0)+1 AS so FROM budget_lines WHERE scenario_id=$1', [id]);
  const [row] = await q(`INSERT INTO budget_lines (scenario_id, entity_id, dept_id, budget_sheet, account, line_name, kind, budget_category, summary_row,
      driver_type, driver_input, is_wage_base, is_custom, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13) RETURNING id`,
    [id, b.entityId || 'E100', dept.dept_id, b.sheet, acct.account, (b.name || acct.name).trim(), kind, b.category || 'Added in the app', b.summaryRow || '',
      b.driverType || (kind === 'REVENUE' ? 'TYPED' : 'FIXED'), numOrNull(b.driverInput), !!b.isWageBase, so]);
  await insertMany(q, 'line_months', ['line_id', 'ym', 'typed', 'override'], Array.from({ length: 12 }, (_, m) => [row.id, ymOf(sc.fiscal_year, m), null, null]));
  await audit(q, who(req), id, 'line:add', null, `${acct.account} ${b.name || acct.name}`, { lineId: row.id, detail: `dept ${dept.dept_id}` });
  res.json({ id: row.id });
}));
api.patch('/lines/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const [l] = await q('SELECT * FROM budget_lines WHERE id=$1', [id]);
  if (!l) throw new HttpError(404, 'Line not found');
  await assertUnlocked(l.scenario_id);
  const b = req.body ?? {};
  const map: Record<string, string> = { driverType: 'driver_type', driverInput: 'driver_input', name: 'line_name', isWageBase: 'is_wage_base',
    fteCount: 'fte_count', fteHours: 'fte_hours', fteRate: 'fte_rate', summaryRow: 'summary_row', category: 'budget_category' };
  for (const [k, colName] of Object.entries(map)) {
    if (!(k in b)) continue;
    const v = ['driverInput', 'fteCount', 'fteHours', 'fteRate'].includes(k) ? numOrNull(b[k]) : b[k];
    await q(`UPDATE budget_lines SET ${colName}=$1 WHERE id=$2`, [v, id]);
    await audit(q, who(req), l.scenario_id, colName, l[colName], v, { lineId: id, detail: `${l.budget_sheet}: ${l.account} ${l.line_name}` });
  }
  res.json({ ok: true });
}));
api.delete('/lines/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const [l] = await q('SELECT * FROM budget_lines WHERE id=$1', [id]);
  if (!l) throw new HttpError(404, 'Line not found');
  await assertUnlocked(l.scenario_id);
  if (!l.is_custom) throw new HttpError(400, 'Only lines added in the app can be deleted');
  await q('DELETE FROM budget_lines WHERE id=$1', [id]);
  await audit(q, who(req), l.scenario_id, 'line:delete', `${l.account} ${l.line_name}`, null, { lineId: id });
  res.json({ ok: true });
}));
api.put('/scenarios/:id/cells', h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  const [sc] = await q('SELECT fiscal_year FROM scenarios WHERE id=$1', [id]);
  const cells: any[] = req.body?.cells ?? [];
  await tx(async (qq) => {
    for (const c of cells) {
      const field = c.field === 'override' ? 'override' : 'typed';
      const [l] = await qq('SELECT id, budget_sheet, account, line_name FROM budget_lines WHERE id=$1 AND scenario_id=$2', [int(c.lineId), id]);
      if (!l) throw new HttpError(400, 'Line is not in this scenario');
      const ym = ymOf(sc.fiscal_year, int(c.month));
      const v = numOrNull(c.value);
      const [old] = await qq(`SELECT ${field} AS v FROM line_months WHERE line_id=$1 AND ym=$2`, [l.id, ym]);
      await qq(`INSERT INTO line_months (line_id, ym, ${field}) VALUES ($1,$2,$3) ON CONFLICT (line_id, ym) DO UPDATE SET ${field}=EXCLUDED.${field}`, [l.id, ym, v]);
      await audit(qq, who(req), id, field === 'override' ? 'override' : 'typed amount', old?.v, v, { lineId: l.id, ym, detail: `${l.budget_sheet}: ${l.account} ${l.line_name}` });
    }
  });
  res.json({ ok: true });
}));
api.put('/scenarios/:id/stats', h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  const [sc] = await q('SELECT fiscal_year FROM scenarios WHERE id=$1', [id]);
  await tx(async (qq) => {
    for (const s of req.body?.items ?? []) {
      if (!['rooms_sold', 'adr', 'ooo_room_nights', 'occ_rooms', 'covers', 'avg_check'].includes(s.key)) continue;
      const ym = ymOf(sc.fiscal_year, int(s.month));
      const dept = String(s.deptId ?? '');
      const [old] = await qq('SELECT value FROM stat_drivers WHERE scenario_id=$1 AND dept_id=$2 AND ym=$3 AND key=$4', [id, dept, ym, s.key]);
      await qq(`INSERT INTO stat_drivers (scenario_id, dept_id, ym, key, value) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (scenario_id, dept_id, ym, key) DO UPDATE SET value=EXCLUDED.value`, [id, dept, ym, s.key, numOrNull(s.value)]);
      await audit(qq, who(req), id, `driver:${s.key}`, old?.value, numOrNull(s.value), { ym, detail: dept ? `dept ${dept}` : 'resort' });
    }
  });
  res.json({ ok: true });
}));

// ---------- levers ----------
const ADJ_COLS = ['label', 'enabled', 'target_type', 'dept_id', 'account', 'line_id', 'stat_key', 'applies_to', 'mode', 'value', 'from_month', 'to_month'];
const adjRow = (b: any) => [String(b.label || 'Lever'), b.enabled !== false, b.targetType || 'ALL', b.deptId || null, b.account || null, b.lineId || null,
  b.statKey || null, b.appliesTo || 'BOTH', b.mode || 'PCT', Number(b.value) || 0, Math.max(0, Math.min(11, Number(b.fromMonth) || 0)),
  Math.max(0, Math.min(11, b.toMonth === undefined ? 11 : Number(b.toMonth)))];
api.post('/scenarios/:id/adjustments', h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  const vals = adjRow(req.body ?? {});
  const [r] = await q(`INSERT INTO adjustments (scenario_id, ${ADJ_COLS.join(',')}) VALUES ($1,${ADJ_COLS.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`, [id, ...vals]);
  await audit(q, who(req), id, 'lever:add', null, `${vals[0]} (${vals[8]} ${vals[9]})`);
  res.json({ id: r.id });
}));
api.patch('/adjustments/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const [a] = await q('SELECT * FROM adjustments WHERE id=$1', [id]);
  if (!a) throw new HttpError(404, 'Lever not found');
  await assertUnlocked(a.scenario_id);
  const merged = { label: a.label, enabled: a.enabled, targetType: a.target_type, deptId: a.dept_id, account: a.account, lineId: a.line_id, statKey: a.stat_key,
    appliesTo: a.applies_to, mode: a.mode, value: a.value, fromMonth: a.from_month, toMonth: a.to_month, ...(req.body ?? {}) };
  const vals = adjRow(merged);
  await q(`UPDATE adjustments SET ${ADJ_COLS.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...vals]);
  await audit(q, who(req), a.scenario_id, 'lever', `${a.label}: ${a.enabled ? 'on' : 'off'}, ${a.mode} ${a.value}`, `${vals[0]}: ${vals[1] ? 'on' : 'off'}, ${vals[8]} ${vals[9]}`);
  res.json({ ok: true });
}));
api.delete('/adjustments/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const [a] = await q('SELECT * FROM adjustments WHERE id=$1', [id]);
  if (!a) return res.json({ ok: true });
  await assertUnlocked(a.scenario_id);
  await q('DELETE FROM adjustments WHERE id=$1', [id]);
  await audit(q, who(req), a.scenario_id, 'lever:delete', a.label, null);
  res.json({ ok: true });
}));

// ---------- cash ----------
const CASH_KEYS = new Set([...CASH_ROWS.filter((r) => !r.computed).map((r) => r.key), 'opening_balance']);
api.put('/scenarios/:id/cash', h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  const [sc] = await q('SELECT fiscal_year FROM scenarios WHERE id=$1', [id]);
  await tx(async (qq) => {
    for (const c of req.body?.items ?? []) {
      if (!CASH_KEYS.has(c.key)) continue;
      const ym = ymOf(sc.fiscal_year, int(c.month));
      const [old] = await qq('SELECT amount FROM cash_items WHERE scenario_id=$1 AND ym=$2 AND item_key=$3', [id, ym, c.key]);
      await qq(`INSERT INTO cash_items (scenario_id, ym, item_key, amount) VALUES ($1,$2,$3,$4)
        ON CONFLICT (scenario_id, ym, item_key) DO UPDATE SET amount=EXCLUDED.amount`, [id, ym, c.key, numOrNull(c.amount)]);
      await audit(qq, who(req), id, `cash:${c.key}`, old?.amount, numOrNull(c.amount), { ym });
    }
    for (const n of req.body?.notes ?? []) {
      await qq(`INSERT INTO cash_notes (scenario_id, item_key, note) VALUES ($1,$2,$3) ON CONFLICT (scenario_id, item_key) DO UPDATE SET note=EXCLUDED.note`, [id, String(n.key), String(n.note ?? '')]);
    }
  });
  res.json({ ok: true });
}));
api.post('/scenarios/:id/cash/import', upload.single('file'), h(async (req, res) => {
  const id = int(req.params.id);
  await assertUnlocked(id);
  if (!req.file) throw new HttpError(400, 'Choose a CSV file');
  const [sc] = await q('SELECT fiscal_year, name FROM scenarios WHERE id=$1', [id]);
  const rows = Papa.parse<Record<string, string>>(req.file.buffer.toString('utf8').replace(/^﻿/, ''), { header: true, skipEmptyLines: true, transformHeader: (x) => x.trim().toLowerCase() }).data;
  let n = 0; const skipped: string[] = [];
  for (const r of rows) {
    const key = (r.item_key || '').trim();
    const ym = (r.ym || '').trim();
    if (!CASH_KEYS.has(key) || !ym.startsWith(`${sc.fiscal_year}-`)) { skipped.push(`${ym} ${key}`); continue; }
    await q(`INSERT INTO cash_items (scenario_id, ym, item_key, amount) VALUES ($1,$2,$3,$4)
      ON CONFLICT (scenario_id, ym, item_key) DO UPDATE SET amount=EXCLUDED.amount`, [id, ym, key, parseMoney(r.amount)]);
    n++;
  }
  await audit(q, who(req), id, 'cash:import', null, `${n} rows from ${req.file.originalname}`);
  res.json({ imported: n, skipped: skipped.slice(0, 30), validKeys: [...CASH_KEYS] });
}));

// ---------- actuals ----------
api.get('/actuals', h(async (req, res) => {
  const year = int(req.query.year);
  res.json({ rows: await actualsBetween(`${year}-01`, `${year}-12`) });
}));
api.get('/actuals/status', h(async (_req, res) => {
  const months = await q(`WITH latest AS (SELECT ym, max(batch_id) AS batch_id FROM actuals GROUP BY ym)
    SELECT l.ym, l.batch_id, b.file_name, b.sage_created_on, b.period_open, b.created_at, m.revenue, m.net_income
    FROM latest l JOIN import_batches b ON b.id = l.batch_id LEFT JOIN import_batch_months m ON m.batch_id = l.batch_id AND m.ym = l.ym ORDER BY l.ym`);
  const all = await q('SELECT m.*, b.sage_created_on, b.file_name FROM import_batch_months m JOIN import_batches b ON b.id=m.batch_id');
  for (const m of months) {
    m.conflicts = all.filter((o: any) => o.ym === m.ym && o.batch_id !== m.batch_id &&
      (Math.abs(o.revenue - m.revenue) > 10000 || Math.abs(o.net_income - m.net_income) > 10000))
      .map((o: any) => ({ batchId: o.batch_id, fileName: o.file_name, sageCreatedOn: o.sage_created_on, revenue: o.revenue, netIncome: o.net_income }));
  }
  res.json({ months });
}));

// ---------- imports ----------
const pending = new Map<string, { parse: GLParse; fileName: string; at: number }>();
async function known() {
  const [a, d, e] = await Promise.all([q('SELECT account FROM accounts'), q('SELECT dept_id FROM departments'), q('SELECT entity_id FROM entities')]);
  return { accounts: new Set<string>(a.map((r: any) => r.account)), depts: new Set<string>(d.map((r: any) => r.dept_id)), entities: new Set<string>(e.map((r: any) => r.entity_id)) };
}
api.post('/import/gl/preview', upload.single('file'), h(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the Sage General Ledger CSV');
  const parse = parseSageGL(req.file.buffer.toString('utf8'));
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60e3) pending.delete(k);
  const token = crypto.randomBytes(12).toString('hex');
  pending.set(token, { parse, fileName: req.file.originalname, at: Date.now() });
  const v = validateGL(parse, await known());
  res.json({ token, fileName: req.file.originalname, lineCount: parse.lineCount, rowCount: parse.rows.length, months: parse.months,
    skipped: parse.skipped, problems: parse.problems, ...v });
}));
api.post('/import/gl/tieout', h(async (req, res) => {
  const p = pending.get(String(req.body?.token));
  if (!p) throw new HttpError(400, 'That preview has expired. Upload the file again.');
  res.json({ tieout: tieOut(p.parse.months, parseExpected(String(req.body?.expected ?? ''))) });
}));
api.post('/import/gl/commit', h(async (req, res) => {
  const { token, sageCreatedOn, expected, addUnknown, periodOpen } = req.body ?? {};
  const p = pending.get(String(token));
  if (!p) throw new HttpError(400, 'That preview has expired. Upload the file again.');
  if (!String(sageCreatedOn ?? '').trim()) throw new HttpError(400, `Enter the Sage "Created on" time printed on the report.`);
  const v = validateGL(p.parse, await known());
  if (!p.parse.lineCount) throw new HttpError(400, 'No ledger lines in this file.');
  if (!v.ok && !addUnknown) throw new HttpError(400, 'Unknown accounts or departments block the save.');
  const tie = tieOut(p.parse.months, parseExpected(String(expected ?? '')));
  const id = await tx(async (qq) => {
    if (addUnknown) {
      await insertMany(qq, 'accounts', ['account', 'name', 'type', 'pl_section'], v.unknownAccounts.map((a) => [a, `Account ${a} (added from import)`, a < '5000' ? 'Revenue' : 'Expense', null]), 'ON CONFLICT DO NOTHING');
      await insertMany(qq, 'departments', ['dept_id', 'dept_name', 'source', 'sort_order'], v.unknownDepts.map((d) => [d, `Department ${d} (added from import)`, 'import', 999]), 'ON CONFLICT DO NOTHING');
      await insertMany(qq, 'entities', ['entity_id', 'entity_name'], v.unknownEntities.map((e) => [e, e]), 'ON CONFLICT DO NOTHING');
    }
    const months = p.parse.months;
    const [b] = await qq(`INSERT INTO import_batches (kind, file_name, period_from, period_to, row_count, total_revenue, total_net_income, sage_created_on, period_open, tieout, created_by)
      VALUES ('GL',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [p.fileName, months[0]?.ym, months[months.length - 1]?.ym, p.parse.lineCount,
        months.reduce((t, m) => t + Math.round(m.revenue * 100), 0) / 100, months.reduce((t, m) => t + Math.round(m.netIncome * 100), 0) / 100,
        String(sageCreatedOn).trim(), periodOpen !== false, JSON.stringify(tie), who(req)]);
    await insertMany(qq, 'actuals', ['batch_id', 'entity_id', 'dept_id', 'account', 'ym', 'amount'], p.parse.rows.map((r) => [b.id, r.entity, r.dept, r.account, r.ym, r.amount]));
    await insertMany(qq, 'import_batch_months', ['batch_id', 'ym', 'revenue', 'net_income'], months.map((m) => [b.id, m.ym, m.revenue, m.netIncome]));
    return b.id as number;
  });
  pending.delete(String(token));
  await audit(q, who(req), null, 'import:gl', null, `${p.fileName}: ${p.parse.lineCount} lines`, { detail: `Sage created on ${sageCreatedOn}` });
  res.json({ id, tieout: tie });
}));
api.post('/import/pl-by-dept', (_req, res) => {
  res.status(501).json({ error: 'The "P&L By Department" importer is not built yet. Use the General Ledger export: it carries account numbers, this report does not.' });
});
api.get('/imports', h(async (_req, res) => {
  const batches = await q('SELECT * FROM import_batches ORDER BY id DESC');
  const months = await q('SELECT * FROM import_batch_months ORDER BY ym');
  res.json({ batches: batches.map((b: any) => ({ ...b, tieout: b.tieout ? JSON.parse(b.tieout) : [], months: months.filter((m: any) => m.batch_id === b.id) })) });
}));
api.delete('/imports/:id', h(async (req, res) => {
  const [b] = await q('SELECT file_name FROM import_batches WHERE id=$1', [int(req.params.id)]);
  await q('DELETE FROM import_batches WHERE id=$1', [int(req.params.id)]);
  await audit(q, who(req), null, 'import:delete', b?.file_name, null);
  res.json({ ok: true });
}));
api.post('/import/workbook', upload.single('file'), h(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the budget workbook (.xlsx)');
  const out = await importWorkbook(req.file.buffer, req.file.originalname, {
    name: req.body?.name?.trim() || undefined, fiscalYear: req.body?.fiscalYear ? int(req.body.fiscalYear) : undefined, who: who(req) });
  await audit(q, who(req), out.scenarioId, 'import:workbook', null, `${req.file.originalname}: ${out.lineCount} lines`);
  res.json(out);
}));

// ---------- exports ----------
api.get('/scenarios/:id/export.xlsx', h(async (req, res) => {
  const b = await loadBundle(int(req.params.id));
  const wb = await buildWorkbook(b);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${b.scenario.name.replace(/[^\w .-]/g, '_')}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));
api.get('/scenarios/:id/export.csv', h(async (req, res) => {
  const b = await loadBundle(int(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${b.scenario.name.replace(/[^\w .-]/g, '_')}.csv"`);
  res.send(buildCsv(b));
}));

// ---------- change log and one-time items ----------
api.get('/audit', h(async (req, res) => {
  const params: any[] = [];
  const cond: string[] = [];
  if (req.query.scenario) { params.push(int(req.query.scenario)); cond.push(`scenario_id=$${params.length}`); }
  if (req.query.q) { params.push(`%${String(req.query.q)}%`); cond.push(`(field ILIKE $${params.length} OR detail ILIKE $${params.length} OR who ILIKE $${params.length})`); }
  res.json({ rows: await q(`SELECT * FROM audit_log ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`, params) });
}));
api.get('/normalizations', h(async (_req, res) => res.json({ rows: await q('SELECT * FROM normalizations ORDER BY ym, id') })));
api.post('/normalizations', h(async (req, res) => {
  const b = req.body ?? {};
  if (!/^\d{4}-\d{2}$/.test(String(b.ym))) throw new HttpError(400, 'Month must look like 2025-12');
  const [r] = await q(`INSERT INTO normalizations (label, account, dept_id, ym, amount, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [String(b.label || 'One-time item'), String(b.account || ''), b.dept_id || null, b.ym, Number(b.amount) || 0, b.enabled !== false]);
  await audit(q, who(req), null, 'normalization:add', null, `${b.label}: ${b.amount}`);
  res.json({ id: r.id });
}));
api.patch('/normalizations/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const [n] = await q('SELECT * FROM normalizations WHERE id=$1', [id]);
  if (!n) throw new HttpError(404, 'Not found');
  const b = { ...n, ...(req.body ?? {}) };
  await q('UPDATE normalizations SET label=$1, account=$2, dept_id=$3, ym=$4, amount=$5, enabled=$6 WHERE id=$7',
    [b.label, String(b.account ?? ''), b.dept_id || null, b.ym, Number(b.amount) || 0, !!b.enabled, id]);
  await audit(q, who(req), null, 'normalization', `${n.label}: ${n.enabled ? 'on' : 'off'} ${n.amount}`, `${b.label}: ${b.enabled ? 'on' : 'off'} ${b.amount}`);
  res.json({ ok: true });
}));
api.delete('/normalizations/:id', h(async (req, res) => {
  await q('DELETE FROM normalizations WHERE id=$1', [int(req.params.id)]);
  res.json({ ok: true });
}));
