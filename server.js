const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 9786;
const HISTORY_FILE = path.join(__dirname, 'crawl-history.json');

// ── Middleware ───────────────────────────────────
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'web-vision-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// ── Auth helpers ─────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── History helpers ──────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function appendHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 50), null, 2));
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Rate limiter for login ───────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' }),
});

// ── Public routes (no auth) ──────────────────────
app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validPass = process.env.ADMIN_PASSWORD || 'admin';
  if (username === validUser && password === validPass) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

// ── Auth wall — everything below requires login ──
app.use(requireAuth);

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/screenshots', express.static(path.join(__dirname, 'output', 'screenshots')));

app.get('/api/me', (req, res) => {
  res.json({ username: req.session.username });
});

// ── Job state ────────────────────────────────────
let job = null;
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ── Crawl ────────────────────────────────────────
app.post('/api/crawl', (req, res) => {
  if (job?.status === 'running') {
    return res.status(409).json({ error: 'A crawl is already running' });
  }

  const { url, maxPages = 30, sameDomain = false } = req.body;
  if (!url?.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL — must start with http(s)' });
  }

  const outDir = path.join(__dirname, 'output');
  try {
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });
  } catch {}

  job = { status: 'running', logs: [], startTime: Date.now(), url };

  const args = [path.join(__dirname, 'agent.js'), url, `--max-pages=${maxPages}`];
  if (sameDomain) args.push('--same-domain');

  const { siteLoginUrl, siteUsername, sitePassword, siteUsernameField, sitePasswordField } = req.body;

  const childEnv = { ...process.env };
  if (siteLoginUrl)      childEnv.SITE_LOGIN_URL      = siteLoginUrl;
  if (siteUsername)      childEnv.SITE_USERNAME       = siteUsername;
  if (sitePassword)      childEnv.SITE_PASSWORD       = sitePassword;
  if (siteUsernameField) childEnv.SITE_USERNAME_FIELD = siteUsernameField;
  if (sitePasswordField) childEnv.SITE_PASSWORD_FIELD = sitePasswordField;

  const child = spawn('node', args, { env: childEnv });
  job.pid = child.pid;

  const onData = (prefix) => (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      const entry = prefix ? `${prefix}${line}` : line;
      job.logs.push(entry);
      broadcast({ type: 'log', line: entry });
    });
  };

  child.stdout.on('data', onData(''));
  child.stderr.on('data', onData('[err] '));

  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.endTime = Date.now();

    let pageCount = 0;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'output', 'report.json'), 'utf8'));
      pageCount = Array.isArray(report) ? report.length : 0;
    } catch {}

    appendHistory({
      url: job.url,
      status: job.status,
      startTime: job.startTime,
      endTime: job.endTime,
      duration: formatDuration(job.endTime - job.startTime),
      pageCount,
    });

    broadcast({ type: 'done', code, status: job.status });
  });

  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (job) {
    job.logs.forEach(line =>
      res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`)
    );
    if (job.status !== 'running') {
      res.write(`data: ${JSON.stringify({ type: 'done', code: job.status === 'done' ? 0 : 1, status: job.status })}\n\n`);
    }
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/status', (req, res) => {
  if (!job) return res.json({ status: 'idle' });
  res.json({ status: job.status, url: job.url, startTime: job.startTime, endTime: job.endTime || null });
});

// ── History ──────────────────────────────────────
app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

// ── Export (zip download) ────────────────────────
app.get('/api/export', (req, res) => {
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) {
    return res.status(404).json({ error: 'No report to export yet' });
  }

  let domain = 'report';
  try { domain = new URL(job?.url || '').hostname.replace(/\./g, '-'); } catch {}
  const date = new Date().toISOString().slice(0, 10);
  const filename = `crawl-${domain}-${date}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);
  archive.directory(outDir, false);
  archive.finalize();
});

// ── Report files ─────────────────────────────────
app.get('/api/report.json', (req, res) => {
  const p = path.join(__dirname, 'output', 'report.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No report yet' });
  res.sendFile(p);
});

app.get('/api/report.md', (req, res) => {
  const p = path.join(__dirname, 'output', 'report.md');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No report yet' });
  res.type('text/plain').sendFile(p);
});

app.get('/api/screenshots', (req, res) => {
  const d = path.join(__dirname, 'output', 'screenshots');
  if (!fs.existsSync(d)) return res.json([]);
  res.json(fs.readdirSync(d).filter(f => f.endsWith('.png')));
});

// ── Start ────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🕷️   The Crawler → http://localhost:${PORT}\n`);
  console.log(`    Login: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD ? '(from env)' : 'admin'}`);
  console.log(`    Change ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET in .env\n`);
});
