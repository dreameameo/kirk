'use strict';
// kerk - watch release pages, tell me when something new ships. Zero dependencies (Node >= 22).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch {}

const VERSION = '0.1.0';
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config ----------
const CONFIG_PATH = path.resolve(process.argv[2] || process.env.KERK_CONFIG || 'config.json');
const DEFAULTS = {
  listen: '0.0.0.0:8080',
  dataDir: './data',
  interval: '1h',
  auth: { enabled: false, username: 'admin', password: '' },
  github: { token: '', apiUrl: 'https://api.github.com' },
  notifiers: {},
  projects: [],
};

function parseDuration(v, fallbackMs) {
  if (typeof v === 'number') return Math.max(30, v) * 1000;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(v || '').trim());
  if (!m) return fallbackMs;
  return Math.max(30, Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]) * 1000;
}

let cfg;
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
    log(`created default config at ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const c = { ...DEFAULTS, ...raw, auth: { ...DEFAULTS.auth, ...raw.auth }, github: { ...DEFAULTS.github, ...raw.github } };
  c.notifiers ||= {}; c.projects ||= [];
  const env = process.env;
  if (env.KERK_LISTEN) c.listen = env.KERK_LISTEN;
  if (env.KERK_DATA_DIR) c.dataDir = env.KERK_DATA_DIR;
  if (env.KERK_USERNAME) c.auth.username = env.KERK_USERNAME;
  if (env.KERK_PASSWORD) c.auth.password = env.KERK_PASSWORD;
  if (env.KERK_GITHUB_TOKEN) c.github.token = env.KERK_GITHUB_TOKEN;
  c.dataDir = path.resolve(path.dirname(CONFIG_PATH), c.dataDir);
  if (c.auth.enabled && !c.auth.password) throw new Error('auth.enabled is true but no password is set (config or KERK_PASSWORD)');
  return c;
}

// Only notifiers/projects are rewritten; env-injected secrets never reach the file.
function saveConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  raw.notifiers = cfg.notifiers; raw.projects = cfg.projects;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}

// ---------- state ----------
let state = {};
let statePath;
function loadState() {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  statePath = path.join(cfg.dataDir, 'state.json');
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { state = {}; }
}
function saveState() {
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

// ---------- http helper ----------
async function req(url, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  return fetch(url, { method, headers: { 'User-Agent': `kerk/${VERSION}`, ...headers }, body, signal: AbortSignal.timeout(timeout) });
}
async function must(res, what) {
  if (res.ok) return res;
  const t = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
  throw new Error(`${what}: HTTP ${res.status}${t ? ' ' + t : ''}`);
}

// ---------- release sources ----------
const sources = {
  async github(p) {
    const h = { Accept: 'application/vnd.github+json' };
    if (cfg.github.token) h.Authorization = `Bearer ${cfg.github.token}`;
    const base = `${cfg.github.apiUrl.replace(/\/$/, '')}/repos/${p.repo}`;
    if (p.prereleases) {
      const list = await (await must(await req(`${base}/releases?per_page=10`, { headers: h }), 'github')).json();
      const r = list.find(x => !x.draft);
      if (r) return { version: r.tag_name, url: r.html_url };
    } else {
      const res = await req(`${base}/releases/latest`, { headers: h });
      if (res.ok) { const r = await res.json(); return { version: r.tag_name, url: r.html_url }; }
      if (res.status !== 404) await must(res, 'github');
    }
    // no releases published: fall back to the newest tag
    const tags = await (await must(await req(`${base}/tags?per_page=1`, { headers: h }), 'github')).json();
    if (!tags.length) throw new Error('github: no releases or tags found');
    return { version: tags[0].name, url: `https://github.com/${p.repo}/releases/tag/${tags[0].name}` };
  },
  async gitlab(p) {
    const host = (p.host || 'https://gitlab.com').replace(/\/$/, '');
    const r = await (await must(await req(`${host}/api/v4/projects/${encodeURIComponent(p.repo)}/releases?per_page=1`), 'gitlab')).json();
    if (!r.length) throw new Error('gitlab: no releases found');
    return { version: r[0].tag_name, url: r[0]._links?.self || `${host}/${p.repo}/-/releases` };
  },
  async url(p) {
    const body = await (await must(await req(p.url), 'page')).text();
    const m = new RegExp(p.regex).exec(body);
    if (!m) throw new Error('regex did not match page content');
    return { version: m[1] ?? m[0], url: p.url };
  },
};

function validateProject(p, isNew) {
  if (!p || typeof p !== 'object') throw new Error('invalid project');
  const name = String(p.name || '').trim();
  if (!name) throw new Error('name is required');
  const id = String(p.id || name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''));
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error('invalid id');
  if (isNew && cfg.projects.some(x => x.id === id)) throw Object.assign(new Error(`project "${id}" already exists`), { code: 409 });
  if (!sources[p.type]) throw new Error(`type must be one of: ${Object.keys(sources).join(', ')}`);
  const out = { id, name, type: p.type };
  if (p.type === 'url') {
    if (!/^https?:\/\//.test(p.url || '')) throw new Error('url must start with http(s)://');
    if (!p.regex) throw new Error('regex is required for type "url"');
    try { new RegExp(p.regex); } catch { throw new Error('regex is not valid'); }
    out.url = p.url; out.regex = p.regex;
  } else {
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(p.repo || '')) throw new Error('repo must look like owner/name');
    out.repo = p.repo;
    if (p.host) out.host = p.host;
    if (p.prereleases) out.prereleases = true;
  }
  if (p.interval) {
    if (!parseDuration(p.interval, 0)) throw new Error('interval must look like 30m, 6h or 1d');
    out.interval = p.interval;
  }
  if (Array.isArray(p.notify)) out.notify = p.notify.filter(n => cfg.notifiers[n]);
  return out;
}

// ---------- notifications ----------
const render = (v, vars) => typeof v === 'string' ? v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
  : Array.isArray(v) ? v.map(x => render(x, vars))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x, vars)])) : v;
const jsonPost = (url, obj, headers = {}) => req(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj) });

const senders = {
  async gotify(n, m) {
    const url = `${n.url.replace(/\/$/, '')}/message?token=${encodeURIComponent(n.token)}`;
    await must(await jsonPost(url, {
      title: m.title, message: m.message, priority: n.priority ?? 5,
      extras: m.url ? { 'client::notification': { click: { url: m.url } } } : undefined,
    }), 'gotify');
  },
  async slack(n, m) { await must(await jsonPost(n.url, { text: `*${m.title}*\n${m.message}` }), 'slack'); },
  async discord(n, m) { await must(await jsonPost(n.url, { content: `**${m.title}**\n${m.message}` }), 'discord'); },
  async ntfy(n, m) {
    const h = { Title: m.title };
    if (m.url) h.Click = m.url;
    if (n.token) h.Authorization = `Bearer ${n.token}`;
    await must(await req(n.url, { method: 'POST', headers: h, body: m.message }), 'ntfy');
  },
  async telegram(n, m) {
    await must(await jsonPost(`https://api.telegram.org/bot${n.token}/sendMessage`, { chat_id: n.chat_id, text: `${m.title}\n${m.message}` }), 'telegram');
  },
  async webhook(n, m) {
    const vars = { title: m.title, message: m.message, url: m.url || '', project: m.project, version: m.version, previous: m.previous || '' };
    const payload = n.body !== undefined ? render(n.body, vars) : { ...vars, event: m.test ? 'test' : 'release' };
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers = { 'Content-Type': typeof payload === 'string' ? 'text/plain' : 'application/json', ...render(n.headers || {}, vars) };
    if (n.secret) headers['X-Kerk-Signature'] = 'sha256=' + crypto.createHmac('sha256', n.secret).update(body).digest('hex');
    await must(await req(n.url, { method: n.method || 'POST', headers, body }), 'webhook');
  },
};
const requiredFields = { gotify: ['url', 'token'], slack: ['url'], discord: ['url'], ntfy: ['url'], telegram: ['token', 'chat_id'], webhook: ['url'] };

function validateNotifier(n) {
  if (!senders[n?.type]) throw new Error(`type must be one of: ${Object.keys(senders).join(', ')}`);
  for (const f of requiredFields[n.type]) if (!n[f]) throw new Error(`${f} is required for ${n.type}`);
  if (n.url && !/^https?:\/\//.test(n.url)) throw new Error('url must start with http(s)://');
  const { type, url, token, chat_id, priority, method, headers, body, secret } = n;
  return Object.fromEntries(Object.entries({ type, url, token, chat_id, priority, method, headers, body, secret }).filter(([, v]) => v !== undefined && v !== ''));
}

const mask = s => (s ? '••••' + String(s).slice(-4) : s);
function publicNotifier(name, n) {
  const o = { name, ...n };
  for (const k of ['token', 'secret']) if (o[k]) o[k] = mask(o[k]);
  if (['slack', 'discord'].includes(n.type) && o.url) o.url = mask(o.url);
  return o;
}

async function dispatch(names, msg) {
  const results = [];
  for (const name of names) {
    const n = cfg.notifiers[name];
    if (!n) continue;
    try { await senders[n.type](n, msg); results.push({ name, ok: true }); }
    catch (e) { log(`notifier ${name} failed: ${e.message}`); results.push({ name, ok: false, error: e.message }); }
  }
  return results;
}
const testMsg = () => ({ title: 'kerk test message', message: 'If you can read this, this notifier works.', project: 'kerk', version: VERSION, test: true });

// ---------- checking ----------
const running = new Set();
async function checkProject(p) {
  if (running.has(p.id)) return state[p.id];
  running.add(p.id);
  const st = (state[p.id] ||= {});
  try {
    const r = await sources[p.type](p);
    if (!r.version) throw new Error('no version found');
    st.checkedAt = Date.now(); st.error = null; st.url = r.url;
    if (!st.version) { st.version = r.version; log(`${p.id}: tracking ${r.version}`); }   // first sighting is a baseline, no alert
    else if (r.version !== st.version) {
      const previous = st.version;
      st.previous = previous; st.version = r.version; st.changedAt = Date.now();
      log(`${p.id}: ${previous} -> ${r.version}`);
      st.notified = await dispatch(p.notify ?? Object.keys(cfg.notifiers), {
        title: `${p.name} ${r.version} released`,
        message: `${p.name} updated from ${previous} to ${r.version}.${r.url ? '\n' + r.url : ''}`,
        url: r.url, project: p.name, version: r.version, previous,
      });
    }
  } catch (e) {
    st.checkedAt = Date.now(); st.error = e.message;
    log(`${p.id}: check failed: ${e.message}`);
  } finally { running.delete(p.id); saveState(); }
  return st;
}

async function tick() {
  for (const p of cfg.projects) {
    const every = parseDuration(p.interval, parseDuration(cfg.interval, 3600e3));
    if (Date.now() - (state[p.id]?.checkedAt || 0) >= every) await checkProject(p);
  }
}

// ---------- auth (HTTP Basic, covers UI and API) ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const failures = new Map();
function authorize(r, res) {
  if (!cfg.auth.enabled) return true;
  const ip = r.socket.remoteAddress;
  const f = failures.get(ip);
  const recent = f && Date.now() - f.at < 60000;
  if (recent && f.count >= 5) { send(res, 429, { error: 'too many failed logins, wait a minute' }); return false; }
  const m = /^Basic (.+)$/.exec(r.headers.authorization || '');
  const [u, ...rest] = m ? Buffer.from(m[1], 'base64').toString().split(':') : [''];
  const ok = crypto.timingSafeEqual(sha(u), sha(cfg.auth.username)) && crypto.timingSafeEqual(sha(rest.join(':')), sha(cfg.auth.password));
  if (ok) { failures.delete(ip); return true; }
  if (m) failures.set(ip, { count: (recent ? f.count : 0) + 1, at: Date.now() });
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="kerk", charset="UTF-8"', 'Content-Type': 'application/json' });
  res.end('{"error":"authentication required"}');
  return false;
}

// ---------- server ----------
function send(res, code, obj, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}
// Requiring JSON content-type forces a CORS preflight, so other sites can't make a logged-in browser change anything.
async function readJson(r) {
  if (!(r.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { code: 415 });
  let size = 0; const chunks = [];
  for await (const c of r) { size += c.length; if (size > 65536) throw Object.assign(new Error('body too large'), { code: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { code: 400 }); }
}
const view = p => ({ ...p, state: state[p.id] || {} });
let indexHtml;
function getIndex() {
  if (!indexHtml) indexHtml = sea ? Buffer.from(sea.getAsset('index.html')).toString() : fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  return indexHtml;
}

async function handle(r, res) {
  const url = new URL(r.url, 'http://x');
  const route = `${r.method} ${url.pathname.replace(/\/$/, '') || '/'}`;
  if (route === 'GET /health') return send(res, 200, { status: 'ok', version: VERSION });
  if (!authorize(r, res)) return;
  if (route === 'GET /') return send(res, 200, getIndex(), 'text/html; charset=utf-8');
  if (!url.pathname.startsWith('/api/v1')) return send(res, 404, { error: 'not found' });
  const [kind, id, action] = url.pathname.slice(8).split('/').filter(Boolean).map(decodeURIComponent);

  if (kind === 'projects') {
    if (r.method === 'GET' && !id) return send(res, 200, cfg.projects.map(view));
    if (r.method === 'POST' && !id) {
      const p = validateProject(await readJson(r), true);
      cfg.projects.push(p); saveConfig(); await checkProject(p);
      return send(res, 201, view(p));
    }
    const p = cfg.projects.find(x => x.id === id);
    if (!p) return send(res, 404, { error: 'project not found' });
    if (r.method === 'GET' && !action) return send(res, 200, view(p));
    if (r.method === 'POST' && action === 'check') { await checkProject(p); return send(res, 200, view(p)); }
    if (r.method === 'DELETE' && !action) {
      cfg.projects = cfg.projects.filter(x => x !== p); delete state[p.id]; saveConfig(); saveState();
      return send(res, 200, { deleted: id });
    }
  }
  if (kind === 'notifiers') {
    if (r.method === 'GET' && !id) return send(res, 200, Object.entries(cfg.notifiers).map(([k, v]) => publicNotifier(k, v)));
    if (r.method === 'POST' && id === 'test') {        // try a config before saving it
      const n = validateNotifier(await readJson(r));
      try { await senders[n.type](n, testMsg()); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 502, { ok: false, error: e.message }); }
    }
    if (r.method === 'POST' && !id) {
      const body = await readJson(r);
      const name = String(body.name || '').trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('name may only contain letters, digits, . _ -');
      if (cfg.notifiers[name]) throw Object.assign(new Error(`notifier "${name}" already exists`), { code: 409 });
      cfg.notifiers[name] = validateNotifier(body); saveConfig();
      return send(res, 201, publicNotifier(name, cfg.notifiers[name]));
    }
    if (id && !cfg.notifiers[id]) return send(res, 404, { error: 'notifier not found' });
    if (r.method === 'POST' && action === 'test') {    // test a saved notifier
      const [out] = await dispatch([id], testMsg());
      return send(res, out.ok ? 200 : 502, out);
    }
    if (r.method === 'DELETE' && !action) {
      delete cfg.notifiers[id];
      for (const p of cfg.projects) if (p.notify) p.notify = p.notify.filter(n => n !== id);
      saveConfig(); return send(res, 200, { deleted: id });
    }
  }
  send(res, 404, { error: 'not found' });
}

function main() {
  cfg = loadConfig(); loadState();
  const server = http.createServer((r, res) => {
    handle(r, res).catch(e => { if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message }); });
  });
  const i = cfg.listen.lastIndexOf(':');
  server.listen(Number(cfg.listen.slice(i + 1)), cfg.listen.slice(0, i) || '0.0.0.0', () => {
    log(`kerk ${VERSION} listening on ${cfg.listen} (auth ${cfg.auth.enabled ? 'on' : 'OFF'}), ${cfg.projects.length} project(s), data in ${cfg.dataDir}`);
  });
  const timer = setInterval(() => tick().catch(e => log('tick error', e.message)), 15000);
  tick().catch(() => {});
  const stop = () => { clearInterval(timer); saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main();
