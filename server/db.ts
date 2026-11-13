// One small database layer. Uses Replit PostgreSQL when DATABASE_URL is set,
// otherwise an embedded Postgres (PGlite) stored in ./.pgdata so the app runs anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Q = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
const here = path.dirname(fileURLToPath(import.meta.url));

let run: Q;
let runTx: <T>(fn: (q: Q) => Promise<T>) => Promise<T>;
let execMany: (sql: string) => Promise<void>;
let ready: Promise<void> | null = null;
export let dbKind = '';

async function init() {
  const url = process.env.DATABASE_URL;
  if (url && !process.env.USE_PGLITE) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v: string) => Number(v)); // bigint (count)
    pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric
    const ssl = /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: url, max: 5, ssl });
    run = async (sql, params) => (await pool.query(sql, params)).rows;
    execMany = async (sql) => { await pool.query(sql); };
    runTx = async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, params) => (await c.query(sql, params)).rows);
        await c.query('COMMIT');
        return out;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    dbKind = 'PostgreSQL';
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR ?? path.join(here, '..', '.pgdata');
    const db = dir === 'memory' ? new PGlite() : new PGlite(dir);
    run = async (sql, params) => (await db.query(sql, params)).rows as any[];
    execMany = async (sql) => { await db.exec(sql); };
    runTx = (fn) => db.transaction(async (tx) => fn(async (sql, params) => (await tx.query(sql, params)).rows as any[])) as any;
    dbKind = 'embedded PGlite (no DATABASE_URL set)';
  }
  await execMany(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
}

export function dbReady() { return (ready ??= init()); }
export const q: Q = async (sql, params) => { await dbReady(); return run(sql, params); };
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> { await dbReady(); return runTx(fn); }

/** Multi-row insert in chunks. `suffix` can carry ON CONFLICT ... or RETURNING. */
export async function insertMany(qq: Q, table: string, cols: string[], rows: any[][], suffix = ''): Promise<any[]> {
  const out: any[] = [];
  const size = Math.max(1, Math.floor(3000 / cols.length));
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const params: any[] = [];
    const values = chunk.map((r) => `(${r.map((v) => { params.push(v === undefined ? null : v); return `$${params.length}`; }).join(',')})`).join(',');
    out.push(...(await qq(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${suffix}`, params)));
  }
  return out;
}
