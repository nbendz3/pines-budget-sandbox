// Pines Budget Sandbox server: one Express app serves the API and the screens.
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbReady, dbKind, q } from './db';
import { runSeed } from './seed';
import { api } from './routes';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const prod = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 5000;
const PASSWORD = process.env.APP_PASSWORD || '';
const OPEN = process.env.ALLOW_NO_PASSWORD === '1'; // local testing only
const SECRET = crypto.createHash('sha256').update(`pines|${process.env.SESSION_SECRET || ''}|${PASSWORD}`).digest();
const COOKIE = 'pbs_session';
// Replit's workspace preview shows the app inside a frame on another site, which needs SameSite=None.
const FRAMED = !!process.env.REPL_ID && process.env.REPLIT_DEPLOYMENT !== '1';
const cookieFlags = (req: express.Request) => (FRAMED && req.secure ? 'SameSite=None; Secure' : `SameSite=Lax${req.secure ? '; Secure' : ''}`);
const DAYS = 14;

const sign = (payload: string) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
function makeToken(name: string) {
  const payload = Buffer.from(JSON.stringify({ n: name.slice(0, 40), e: Date.now() + DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readToken(token: string | undefined): { n: string } | null {
  if (!token) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const good = sign(payload);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.e > Date.now() ? { n: String(p.n || '') } : null;
  } catch { return null; }
}
const cookieOf = (req: express.Request) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });

// ---- login gate: one shared password from the APP_PASSWORD secret
const attempts = new Map<string, { n: number; until: number }>();
app.get('/api/me', (req, res) => {
  const s = OPEN ? { n: 'local' } : readToken(cookieOf(req));
  res.json({ authed: !!s, name: s?.n ?? null, passwordSet: !!PASSWORD || OPEN });
});
app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.status(503).json({ error: 'Set the APP_PASSWORD secret first, then restart the app.' });
  const ip = req.ip || 'x';
  const a = attempts.get(ip);
  if (a && a.until > Date.now() && a.n >= 8) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
  const given = crypto.createHash('sha256').update(String(req.body?.password ?? '')).digest();
  const want = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, want)) {
    attempts.set(ip, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60e3 });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  attempts.delete(ip);
  const name = String(req.body?.name || 'Someone').trim() || 'Someone';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(name)}; Path=/; HttpOnly; ${cookieFlags(req)}; Max-Age=${DAYS * 86400}`);
  res.json({ ok: true, name });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  const s = OPEN ? { n: 'local' } : readToken(cookieOf(req));
  if (!s) return res.status(401).json({ error: 'Please sign in.' });
  // changes must come from the app's own pages (a custom header a cross-site form cannot send)
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'pbs') return res.status(403).json({ error: 'Blocked: request did not come from the app.' });
  (req as any).who = s.n;
  next();
});
app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

async function main() {
  const server = http.createServer(app);
  await dbReady();
  const [{ n }] = await q<{ n: number }>('SELECT count(*)::int AS n FROM entities');
  if (!n) { console.log('Empty database: loading the seed files...'); await runSeed(); }

  if (prod && fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    app.use(express.static(path.join(root, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: process.env.NO_HMR ? false : { server }, allowedHosts: true as any },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Something went wrong' });
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pines Budget Sandbox on port ${PORT} - database: ${dbKind}`);
    if (!PASSWORD && !OPEN) console.log('APP_PASSWORD is not set: nobody can sign in until it is.');
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
