// End-to-end smoke test: node test/smoke.js
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

let tag = 'v1.0.0'; const got = [];
const mock = http.createServer((r, res) => {
  let b = ''; r.on('data', c => b += c); r.on('end', () => {
    if (r.url.startsWith('/repos/acme/tool/releases/latest')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ tag_name: tag, html_url: 'https://example.test/' + tag })); }
    if (r.url === '/page') return res.end(`<p>Latest: v2.5.1</p>`);
    if (r.url === '/fail') { res.statusCode = 500; return res.end('nope'); }
    got.push({ url: r.url, headers: r.headers, body: b }); res.end('{}');
  });
});

(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const M = `http://127.0.0.1:${mock.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kerk-'));
  const conf = path.join(dir, 'config.json');
  fs.writeFileSync(conf, JSON.stringify({
    listen: '127.0.0.1:18080', dataDir: './data', github: { apiUrl: M },
    auth: { enabled: true, username: 'me', password: 'pw' },
    notifiers: {
      g: { type: 'gotify', url: M + '/gotify', token: 'T0KEN' },
      s: { type: 'slack', url: M + '/slack' },
      h: { type: 'webhook', url: M + '/hook', secret: 'sek', body: { text: '{{project}} -> {{version}}' } },
      n: { type: 'ntfy', url: M + '/ntfy/topic' },
    },
    projects: [{ id: 'tool', name: 'Tool', type: 'github', repo: 'acme/tool' }],
  }));
  const proc = spawn(process.execPath, ['src/kerk.js', conf], { stdio: 'inherit' });
  const B = 'http://127.0.0.1:18080', auth = 'Basic ' + Buffer.from('me:pw').toString('base64');
  const call = async (m, p, body, a = auth) => {
    const r = await fetch(B + p, { method: m, headers: { ...(a && { Authorization: a }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null), text: null };
  };
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  try {
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('GET', '/api/v1/projects', null, null)).status, 401);
    assert.equal((await call('GET', '/api/v1/projects', null, 'Basic ' + Buffer.from('me:bad').toString('base64'))).status, 401);
    const html = await fetch(B + '/', { headers: { Authorization: auth } });
    assert.match(await html.text(), /<title>kerk<\/title>/);

    let p = (await call('GET', '/api/v1/projects/tool')).json;
    for (let i = 0; i < 40 && !p.state.version; i++) { await new Promise(r => setTimeout(r, 100)); p = (await call('GET', '/api/v1/projects/tool')).json; }
    assert.equal(p.state.version, 'v1.0.0'); assert.equal(got.length, 0, 'baseline must not notify');

    tag = 'v1.1.0';
    p = (await call('POST', '/api/v1/projects/tool/check')).json;
    assert.equal(p.state.version, 'v1.1.0'); assert.equal(p.state.previous, 'v1.0.0');
    assert.equal(got.length, 4, 'all four notifiers fire');
    const gotify = got.find(g => g.url.startsWith('/gotify/message?token=T0KEN'));
    assert.match(JSON.parse(gotify.body).message, /v1.0.0 to v1.1.0/);
    const hook = got.find(g => g.url === '/hook');
    assert.equal(JSON.parse(hook.body).text, 'Tool -> v1.1.0'); assert.match(hook.headers['x-kerk-signature'], /^sha256=[0-9a-f]{64}$/);
    assert.equal(got.find(g => g.url === '/ntfy/topic').headers.title, 'Tool v1.1.0 released');

    got.length = 0;
    assert.equal((await call('POST', '/api/v1/notifiers/s/test')).status, 200); assert.equal(got.length, 1);
    assert.equal((await call('POST', '/api/v1/notifiers/test', { type: 'gotify', url: M + '/gotify', token: 'x' })).status, 200);
    assert.equal((await call('POST', '/api/v1/notifiers/test', { type: 'gotify', url: 'http://127.0.0.1:9', token: 'x' })).status, 502);
    const list = (await call('GET', '/api/v1/notifiers')).json;
    assert.ok(!JSON.stringify(list).includes('T0KEN'), 'secrets are masked'); assert.equal(list.length, 4);

    // add a regex-page project and a failing one, then notifier + project removal persists to config
    const add = await call('POST', '/api/v1/projects', { name: 'Page', type: 'url', url: M + '/page', regex: 'Latest: v([\\d.]+)', notify: ['g'] });
    assert.equal(add.status, 201); assert.equal(add.json.state.version, '2.5.1');
    assert.equal((await call('POST', '/api/v1/projects', { name: 'Page', type: 'url', url: M + '/page', regex: 'x' })).status, 409);
    assert.equal((await call('POST', '/api/v1/projects', { name: 'Bad', type: 'url', url: M + '/fail', regex: 'x' })).json.state.error.includes('500'), true);
    assert.equal((await call('POST', '/api/v1/projects', { name: 'x', type: 'github', repo: 'nope' })).status, 400);
    await call('DELETE', '/api/v1/projects/bad');
    const saved = JSON.parse(fs.readFileSync(conf, 'utf8'));
    assert.deepEqual(saved.projects.map(p => p.id), ['tool', 'page']); assert.equal(saved.auth.password, 'pw');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/state.json'))).tool.version, 'v1.1.0');
    // csrf guard: non-json POST rejected
    const r = await fetch(B + '/api/v1/projects', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
    console.log('\nALL SMOKE TESTS PASSED');
  } catch (e) { console.error('\nFAILED:', e); process.exitCode = 1; }
  proc.kill(); mock.close();
})();
