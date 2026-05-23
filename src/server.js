import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';
import webpush from 'web-push';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');
const statePath = path.join(dataDir, 'state.json');
const vapidPath = path.join(dataDir, 'vapid.json');

const glossoBase = 'https://glosso.ink';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3099);
const pollMs = Math.max(15, Number(process.env.POLL_SECONDS || 60)) * 1000;
const rankoPollMs = Math.max(5, Number(process.env.RANKO_POLL_MINUTES || 30)) * 60 * 1000;
const gatewayToken = process.env.GATEWAY_TOKEN || '';
const allowedGlossoUser = (process.env.ALLOWED_GLOSSO_USER || '').trim().toLowerCase();

if (!process.env.GLOSSO_USER || !process.env.GLOSSO_PASS) {
  throw new Error('GLOSSO_USER and GLOSSO_PASS are required in .env');
}

await fs.mkdir(dataDir, { recursive: true });

const vapid = await loadVapidKeys();
webpush.setVapidDetails(
  process.env.WEB_PUSH_SUBJECT || 'mailto:admin@localhost',
  vapid.publicKey,
  vapid.privateKey,
);

let state = await loadState();
let pollTimer = null;
let rankoTimer = null;
let pollInFlight = false;
let rankoPollInFlight = false;
let lastPoll = null;
let lastError = null;
let lastRankoPoll = null;
let lastRankoError = null;

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    lastPoll,
    lastError,
    lastRankoPoll,
    lastRankoError,
    subscriberCount: state.subscriptions.length,
  });
});

app.get('/login', (req, res) => {
  if (authorized(req)) return res.redirect('/');
  return res.type('html').send(renderLoginPage());
});

app.get('/launch', (req, res) => {
  if (!authorized(req)) return res.redirect('/login');
  const target = recentLaunchTarget();
  if (target) return res.redirect(target);
  return res.redirect('/');
});

app.post('/login', (req, res) => {
  const user = req.body?.username || '';
  const pass = req.body?.password || '';
  if (!allowedUser(user)) {
    return res.status(403).type('html').send(renderLoginPage('This gateway is private.'));
  }
  if (!safeEqual(user, process.env.GLOSSO_USER) || !safeEqual(pass, process.env.GLOSSO_PASS)) {
    return res.status(401).type('html').send(renderLoginPage('Wrong username or password.'));
  }

  res.cookie('glossonotif_session', sessionCookieValue(), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 180,
    path: '/',
  });
  return res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie('glossonotif_session', { path: '/' });
  res.redirect('/login');
});

app.get('/open', (req, res) => {
  const target = safeGlossoUrl(req.query.url) || `${glossoBase}/notifications`;
  res.redirect(target);
});

app.get(['/manifest.json', '/icon.svg', '/style.css', '/sw.js'], (req, res, next) => {
  express.static(publicDir)(req, res, next);
});

app.use(authenticateGateway);
app.use(express.static(publicDir));

app.get('/api/config', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    publicKey: vapid.publicKey,
    pollSeconds: Math.round(pollMs / 1000),
    subscriberCount: state.subscriptions.length,
    lastPoll,
    lastError,
    rankoPollMinutes: Math.round(rankoPollMs / 60_000),
    lastRankoPoll,
    lastRankoError,
  });
});

app.get('/api/launch-target', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    url: recentLaunchTarget(),
    at: state.lastLaunchAt || null,
  });
});

app.post('/api/subscribe', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const subscription = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }

  state.subscriptions = state.subscriptions.filter((sub) => sub.endpoint !== subscription.endpoint);
  state.subscriptions.push(subscription);
  await saveState();
  res.json({ ok: true, subscriberCount: state.subscriptions.length });
});

app.post('/api/unsubscribe', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const endpoint = req.body?.endpoint;
  state.subscriptions = state.subscriptions.filter((sub) => sub.endpoint !== endpoint);
  await saveState();
  res.json({ ok: true, subscriberCount: state.subscriptions.length });
});

app.post('/api/test', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const latest = await latestNotificationUrl().catch(() => null);
  const sent = await pushToAll({
    title: 'Glosso gateway',
    body: 'test push from glossonotif',
    url: latest || `${glossoBase}/notifications`,
    tag: 'glossonotif-test',
  });
  res.json({ ok: true, sent, url: latest || `${glossoBase}/notifications` });
});

app.post('/api/poll-now', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const result = await pollOnce({ manual: true });
  res.json(result);
});

async function shutdown() {
  if (pollTimer) clearInterval(pollTimer);
  if (rankoTimer) clearInterval(rankoTimer);
  await saveState();
  process.exit(0);
}

function authorized(req) {
  if (!gatewayToken) return true;
  return req.get('x-gateway-token') === gatewayToken
    || req.query.token === gatewayToken
    || hasBasicAuth(req)
    || hasSessionAuth(req);
}

function authenticateGateway(req, res, next) {
  if (authorized(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  if (req.accepts('html')) return res.redirect('/login');
  res.set('WWW-Authenticate', 'Basic realm="Glosso push gateway"');
  return res.status(401).send('Authentication required');
}

function hasBasicAuth(req) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split === -1) return false;

  const user = decoded.slice(0, split);
  const pass = decoded.slice(split + 1);
  return allowedUser(user) && safeEqual(user, process.env.GLOSSO_USER) && safeEqual(pass, process.env.GLOSSO_PASS);
}

function allowedUser(user) {
  if (!allowedGlossoUser) return true;
  return String(user).trim().toLowerCase() === allowedGlossoUser;
}

function safeEqual(left = '', right = '') {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasSessionAuth(req) {
  return safeEqual(parseCookies(req).glossonotif_session || '', sessionCookieValue());
}

function sessionCookieValue() {
  const secret = gatewayToken || process.env.GLOSSO_PASS;
  return crypto
    .createHmac('sha256', secret)
    .update(`${process.env.GLOSSO_USER}:${process.env.GLOSSO_PASS}`)
    .digest('base64url');
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function renderLoginPage(error = '') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Glosso push login</title>
    <link rel="manifest" href="/manifest.json">
    <style>
      :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101014;color:#f2edf7}
      body{margin:0;min-height:100vh;display:grid;place-items:center}
      main{width:min(380px,calc(100vw - 32px))}
      h1{font-size:1.6rem;margin:0 0 18px}
      form{display:grid;gap:10px}
      input,button{box-sizing:border-box;width:100%;border:1px solid #3c3046;border-radius:8px;background:#17111d;color:#f2edf7;font:inherit;padding:12px}
      button{background:#201728;cursor:pointer}
      p{color:#f0a8bd;min-height:1.3em}
    </style>
  </head>
  <body>
    <main>
      <h1>Glosso push</h1>
      <form method="post" action="/login">
        <input name="username" autocomplete="username" placeholder="Glosso username" required autofocus>
        <input name="password" type="password" autocomplete="current-password" placeholder="Glosso password" required>
        <button type="submit">Log in</button>
      </form>
      <p>${escapeHtml(error)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function safeGlossoUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.origin === glossoBase ? url.toString() : null;
  } catch {
    return null;
  }
}

function recentLaunchTarget() {
  if (!safeGlossoUrl(state.lastLaunchUrl) || !state.lastLaunchAt) return null;
  const ageMs = Date.now() - new Date(state.lastLaunchAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 1000 * 60 * 60 * 12) return null;
  return state.lastLaunchUrl;
}

async function pollOnce({ bootstrap = false, manual = false } = {}) {
  if (pollInFlight) return { ok: false, skipped: 'poll already running' };
  pollInFlight = true;
  try {
    const notifications = await fetchGlossoNotifications();
    const known = new Set(state.seenIds);
    const newItems = notifications.filter((item) => !known.has(item.id)).reverse();

    if (bootstrap && state.seenIds.length === 0) {
      for (const item of notifications) known.add(item.id);
      state.seenIds = [...known].slice(-1000);
      await saveState();
      lastPoll = new Date().toISOString();
      lastError = null;
      return { ok: true, bootstrapped: notifications.length, pushed: 0 };
    }

    let pushed = 0;
    for (const item of newItems) {
      known.add(item.id);
      pushed += await pushToAll({
        title: 'Glosso',
        body: item.text,
        url: item.url,
        tag: item.id,
      });
    }

    state.seenIds = [...known].slice(-1000);
    await saveState();
    lastPoll = new Date().toISOString();
    lastError = null;
    return { ok: true, checked: notifications.length, newItems: newItems.length, pushed, manual };
  } catch (error) {
    lastError = error.message;
    throw error;
  } finally {
    pollInFlight = false;
  }
}

async function fetchGlossoNotifications() {
  const jar = await loginGlosso();
  const html = await fetchText('/notifications', { jar });
  if (!html.includes('Notifications')) throw new Error('Glosso login did not reach notifications page');
  return parseNotifications(html);
}

async function loginGlosso() {
  const jar = new CookieJar();
  const loginPage = await fetchText('/', { jar });
  const csrf = extractCsrf(loginPage);
  if (!csrf) throw new Error('could not find Glosso CSRF token');

  const body = new URLSearchParams({
    _csrf: csrf,
    username: process.env.GLOSSO_USER,
    password: process.env.GLOSSO_PASS,
  });

  await fetchText('/login', {
    jar,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  return jar;
}

async function latestNotificationUrl() {
  const notifications = await fetchGlossoNotifications();
  return notifications[0]?.url || null;
}

async function pollRankoOnce({ bootstrap = false } = {}) {
  if (rankoPollInFlight) return { ok: false, skipped: 'ranko poll already running' };
  rankoPollInFlight = true;
  try {
    const snapshot = await fetchRankoSnapshot();
    const previous = state.rankoNotifiedSnapshot || state.rankoSnapshot;
    state.rankoSnapshot = snapshot;
    lastRankoPoll = new Date().toISOString();
    lastRankoError = null;

    if (bootstrap || !previous) {
      state.rankoNotifiedSnapshot = snapshot;
      await saveState();
      return { ok: true, bootstrapped: true, snapshot, pushed: 0 };
    }

    const ratingDelta = snapshot.ratings - previous.ratings;
    const raterDelta = snapshot.raters - previous.raters;
    const revealedDelta = rankoRevealedDelta(snapshot, previous);
    if (raterDelta < 1 && ratingDelta < 10 && revealedDelta < 1) {
      await saveState();
      return { ok: true, snapshot, ratingDelta, raterDelta, revealedDelta, pushed: 0 };
    }

    const sent = await pushToAll({
      title: 'Ranko',
      body: rankoPushBody(snapshot, ratingDelta, raterDelta, revealedDelta),
      url: `${glossoBase}/ranko`,
      tag: `ranko-${snapshot.ratings}-${snapshot.raters}-${snapshot.revealed ?? 'unknown'}`,
    });
    state.rankoNotifiedSnapshot = snapshot;
    await saveState();
    return { ok: true, snapshot, ratingDelta, raterDelta, revealedDelta, pushed: sent };
  } catch (error) {
    lastRankoError = error.message;
    throw error;
  } finally {
    rankoPollInFlight = false;
  }
}

async function fetchRankoSnapshot() {
  const jar = await loginGlosso();
  const html = await fetchText('/ranko', { jar });
  if (!html.includes('Ranko')) throw new Error('Glosso login did not reach Ranko page');
  return parseRankoSnapshot(html);
}

function rankoPushBody(snapshot, ratingDelta, raterDelta, revealedDelta) {
  const parts = [];
  if (revealedDelta >= 1) parts.push(`+${revealedDelta} revealed trait${revealedDelta === 1 ? '' : 's'}`);
  if (raterDelta >= 1) parts.push(`+${raterDelta} rater${raterDelta === 1 ? '' : 's'}`);
  if (ratingDelta >= 1) parts.push(`+${ratingDelta} rating${ratingDelta === 1 ? '' : 's'}`);
  const revealed = snapshot.revealed == null || snapshot.totalAdjectives == null
    ? ''
    : `, ${snapshot.revealed}/${snapshot.totalAdjectives} revealed`;
  return `${parts.join(', ')}. Now ${snapshot.ratings} ratings from ${snapshot.raters} raters${revealed}.`;
}

function rankoRevealedDelta(snapshot, previous) {
  if (!Number.isInteger(snapshot.revealed) || !Number.isInteger(previous.revealed)) return 0;
  return snapshot.revealed - previous.revealed;
}

function parseRankoSnapshot(html) {
  const $ = cheerio.load(html);
  const sub = $('.rk-report .sub').first().text().replace(/\s+/g, ' ').trim();
  const totals = sub.match(/(\d+)\s+ratings?\s+from\s+(\d+)\s+raters?/i);
  if (!totals) throw new Error('could not find Ranko rating totals');

  const revealedTotals = sub.match(/(\d+)\s*\/\s*(\d+)\s+revealed/i);
  return {
    ratings: Number.parseInt(totals[1], 10),
    raters: Number.parseInt(totals[2], 10),
    revealed: revealedTotals ? Number.parseInt(revealedTotals[1], 10) : null,
    totalAdjectives: revealedTotals ? Number.parseInt(revealedTotals[2], 10) : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchText(url, { jar, method = 'GET', headers = {}, body } = {}) {
  const finalUrl = new URL(url, glossoBase).toString();
  const response = await fetchWithCookies(finalUrl, { jar, method, headers, body });
  if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}`);
  return response.text();
}

async function fetchWithCookies(url, { jar, method = 'GET', headers = {}, body } = {}) {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;

  for (let i = 0; i < 8; i += 1) {
    const response = await fetch(currentUrl, {
      method: currentMethod,
      headers: {
        ...headers,
        cookie: jar.header(),
      },
      body: currentBody,
      redirect: 'manual',
    });
    jar.store(response.headers);

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).toString();
    if (response.status === 303 || currentMethod === 'POST') {
      currentMethod = 'GET';
      currentBody = undefined;
    }
  }

  throw new Error(`too many redirects for ${url}`);
}

function extractCsrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="_csrf"]').attr('value') || '';
}

function parseNotifications(html) {
  const $ = cheerio.load(html);
  return $('.notif-item')
    .map((_index, el) => {
      const content = $(el).find('.notif-content');
      const text = content.text().replace(/\s+/g, ' ').trim();
      const time = $(el).find('.notif-time').attr('data-time') || '';
      const href = content.find('a[href]').last().attr('href') || '/notifications';
      const url = new URL(href, glossoBase).toString();
      const id = crypto.createHash('sha256').update(`${time}|${text}|${url}`).digest('hex').slice(0, 24);
      return { id, text, time, url };
    })
    .get()
    .filter((item) => item.text && item.time);
}

async function pushToAll(payload) {
  let sent = 0;
  const liveSubscriptions = [];
  if (safeGlossoUrl(payload.url)) {
    state.lastLaunchUrl = payload.url;
    state.lastLaunchAt = new Date().toISOString();
  }

  for (const subscription of state.subscriptions) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      liveSubscriptions.push(subscription);
      sent += 1;
    } catch (error) {
      if (error.statusCode !== 404 && error.statusCode !== 410) {
        liveSubscriptions.push(subscription);
        console.error('push failed:', error.message);
      }
    }
  }

  if (liveSubscriptions.length !== state.subscriptions.length) {
    state.subscriptions = liveSubscriptions;
    await saveState();
  }

  return sent;
}

async function loadVapidKeys() {
  try {
    return JSON.parse(await fs.readFile(vapidPath, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    await fs.writeFile(vapidPath, JSON.stringify(keys, null, 2));
    return keys;
  }
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return {
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      lastLaunchUrl: typeof parsed.lastLaunchUrl === 'string' ? parsed.lastLaunchUrl : null,
      lastLaunchAt: typeof parsed.lastLaunchAt === 'string' ? parsed.lastLaunchAt : null,
      rankoSnapshot: validRankoSnapshot(parsed.rankoSnapshot) ? parsed.rankoSnapshot : null,
      rankoNotifiedSnapshot: validRankoSnapshot(parsed.rankoNotifiedSnapshot) ? parsed.rankoNotifiedSnapshot : null,
    };
  } catch {
    return {
      seenIds: [],
      subscriptions: [],
      lastLaunchUrl: null,
      lastLaunchAt: null,
      rankoSnapshot: null,
      rankoNotifiedSnapshot: null,
    };
  }
}

async function saveState() {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

function validRankoSnapshot(snapshot) {
  return Number.isInteger(snapshot?.ratings) && Number.isInteger(snapshot?.raters);
}

class CookieJar {
  cookies = new Map();

  store(headers) {
    const raw = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookie(headers.get('set-cookie'));

    for (const entry of raw) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  header() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/g).map((item) => item.trim());
}

app.listen(port, host, () => {
  console.log(`glossonotif listening on http://${host}:${port}`);
  console.log('open with the Glosso username/password from .env');
});

await pollOnce({ bootstrap: true });
await pollRankoOnce({ bootstrap: !state.rankoSnapshot });
pollTimer = setInterval(() => {
  pollOnce().catch((error) => {
    lastError = error.message;
    console.error('poll failed:', error);
  });
}, pollMs);
rankoTimer = setInterval(() => {
  pollRankoOnce().catch((error) => {
    lastRankoError = error.message;
    console.error('ranko poll failed:', error);
  });
}, rankoPollMs);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
