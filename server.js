const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// ── External key website ─────────────────────────
const KEY_SITE        = process.env.KEY_SITE        || 'https://entities-drawing-repeated-ted.trycloudflare.com';
const KEY_CHECK_PATH  = process.env.KEY_CHECK_PATH  || '/api/check';

// ── Your live hub script (pastefy) ───────────────
const SCRIPT_URL = process.env.SCRIPT_URL ||
  'https://pastefy.app/171bVTMA/raw';

const tokens = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;

// Rate limit
const hits = new Map();
app.use('/api/check', (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 15) return res.status(429).json({ status: 'error', message: 'Too many attempts' });
  arr.push(now);
  hits.set(ip, arr);
  next();
});

// ── /api/check — forwards to key website ─────────
app.post('/api/check', async (req, res) => {
  const { key, hwid } = req.body || {};
  if (!key || !hwid) return res.json({ status: 'error', message: 'Missing key or hwid' });

  let raw;
  try {
    const upstream = await fetch(KEY_SITE + KEY_CHECK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, hwid })
    });
    raw = await upstream.text();
  } catch {
    return res.json({ status: 'error', message: 'Key site unreachable' });
  }

  let data = null;
  try { data = JSON.parse(raw); } catch {}

  const ok = data && (data.status === 'success' || data.success === true || data.valid === true);
  if (!ok) {
    return res.json({
      status: 'error',
      message: (data && (data.message || data.error)) || 'Key rejected by key site'
    });
  }

  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { key, hwid, expires: Date.now() + TOKEN_TTL_MS });

  return res.json({
    status: 'success',
    token,
    key_type: (data && data.key_type) || (data && data.type) || 'standard'
  });
});

// ── /api/script — returns your hub script ────────
app.post('/api/script', async (req, res) => {
  const { key, hwid, token } = req.body || {};
  if (!key || !hwid || !token) return res.json({ status: 'error', message: 'Missing fields' });

  const t = tokens.get(token);
  if (!t || t.key !== key || t.hwid !== hwid || Date.now() > t.expires) {
    return res.json({ status: 'error', message: 'Invalid or expired token' });
  }
  tokens.delete(token);

  try {
    const r = await fetch(SCRIPT_URL);
    const script = await r.text();
    return res.json({ status: 'success', script });
  } catch {
    return res.json({ status: 'error', message: 'Failed to fetch script' });
  }
});

// ── /api/report — proxy ──────────────────────────
app.post('/api/report', async (req, res) => {
  try {
    await fetch(KEY_SITE + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
  } catch {}
  res.json({ status: 'success' });
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokens) if (now > v.expires) tokens.delete(k);
}, 60000);

app.listen(PORT, () => console.log('Primordium API on ' + PORT));
