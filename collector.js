const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs-extra');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const LOG  = path.join(__dirname, 'hits.ndjson');
const SECRET = process.env.HITS_TOKEN || 'change-me';

const seen = new Set();
const rateMap = new Map();

fs.ensureFileSync(LOG);
fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).forEach((line) => {
  try {
    const e = JSON.parse(line);
    if (e.email) seen.add(e.email.toLowerCase());
    if (e.wallet) seen.add(e.wallet.toLowerCase());
  } catch (_) {}
});

app.set('trust proxy', true);
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '8kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const win = rateMap.get(ip) || [];
  const fresh = win.filter((t) => now - t < 60000);
  fresh.push(now);
  rateMap.set(ip, fresh);
  return fresh.length > 10;
}

function validWallet(w) {
  return /^0x[a-fA-F0-9]{40}$/.test(w) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
}

app.post('/collect', async (req, res) => {
  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'slow down' });

  const b = req.body || {};
  const email  = String(b.email  || '').trim();
  const wallet = String(b.wallet || '').trim();
  const name   = String(b.name   || '').trim();

  if (!email || !wallet) return res.status(400).json({ ok: false, error: 'missing fields' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'bad email' });
  if (!validWallet(wallet)) return res.status(400).json({ ok: false, error: 'bad wallet' });

  const eKey = email.toLowerCase();
  const wKey = wallet.toLowerCase();
  const dup = seen.has(eKey) || seen.has(wKey);

  const entry = {
    name,
    email,
    wallet,
    twitter: String(b.twitter || '').trim(),
    ref:     String(b.ref || 'direct').slice(0, 120),
    docref:  String(b.docref || '').slice(0, 200),
    lang:    String(b.lang || '').slice(0, 20),
    tz:      String(b.tz || '').slice(0, 60),
    ua:      String(b.ua || '').slice(0, 400),
    bot:     Boolean(b.bot),
    duplicate: dup,
    ip,
    client_ts: String(b.ts || '').slice(0, 40),
    server_ts: new Date().toISOString()
  };

  try {
    await fs.appendFile(LOG, JSON.stringify(entry) + '\n');
    if (!dup) { seen.add(eKey); seen.add(wKey); }
    console.log('[HIT]', email, wallet, ip, dup ? '(dup)' : '');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/hits', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '') || req.query.token;
  if (token !== SECRET) return res.status(403).json({ error: 'no' });

  const raw = await fs.readFile(LOG, 'utf8');
  if ((req.headers.accept || '').includes('text/html')) {
    const rows = raw.split('\n').filter(Boolean).map((l) => {
      try { const e = JSON.parse(l); return `<tr><td>${e.server_ts}</td><td>${e.email}</td><td>${e.wallet}</td><td>${e.twitter}</td><td>${e.ref}</td><td>${e.ip}</td><td>${e.bot ? 'bot' : ''}${e.duplicate ? 'dup' : ''}</td></tr>`; }
      catch (_) { return ''; }
    }).join('');
    return res.send(`<style>body{font:12px monospace}td{padding:3px 8px;border-bottom:1px solid #ccc}</style><table>${rows}</table>`);
  }
  res.type('application/x-ndjson').send(raw);
});

app.listen(PORT, () => console.log('collector live on :' + PORT));