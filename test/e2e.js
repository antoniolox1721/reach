// End-to-end check against the real relay: starts real programs, then drives them like the dashboard page does.
//   node test/e2e.js                      tests the source
//   REACH_BIN=dist/... node test/e2e.js   tests a built executable (also covers stamped client programs)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
const { Controller, newSecret, publicOf, fleetBase, channelKey, seal, pairOffer, DEFAULT_BROKER } = await import('../docs/core.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-test-'));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const win = process.platform === 'win32';
const BIN = process.env.REACH_BIN && path.resolve(process.env.REACH_BIN);
const PORT = 7790 + Math.floor(Math.random() * 100);
const children = [];
const reach = (args, home, opts = {}) => {
  const env = { ...process.env, REACH_HOME: path.join(tmp, home) };
  const child = BIN ? spawn(BIN, args, { env, ...opts }) : spawn(process.execPath, [path.join(root, 'reach.js'), ...args], { env, ...opts });
  children.push(child);
  return child;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 30000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return;
  throw new Error('timed out waiting for ' + what);
};
// Plain HTTP so the test can set any header, including Host.
const local = (method, url, headers = {}, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}${url}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

const secret = await newSecret();
const pub = publicOf(secret);
const steps = [];
const step = (name, fn) => steps.push([name, fn]);

let ctl, id, machines = [];
const online = (name) => machines.find((m) => m.online && m.name === name);
const collect = async (job, agent = id) => {
  let text = '', code;
  const stop = ctl.watchJob(agent, job, (h, b) => (h.y === 'exit' ? (code = h.code) : (text += Buffer.from(b).toString())));
  await until(() => code !== undefined, 'job exit');
  stop();
  return { text, code };
};

step('a client appears on the dashboard', async () => {
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.writeFileSync(path.join(tmp, 'home', 'config.json'), JSON.stringify({ dpub: pub }));
  reach(['client', '--name', 'test box'], 'home', { stdio: 'ignore' });
  ctl = new Controller({ mqttConnect: mqtt.connect, secret, onMachines: (m) => (machines = m) });
  await ctl.start();
  await until(() => online('test box'), 'presence');
  id = online('test box').id;
  const info = await ctl.info(id);
  assert.equal(info.home, os.homedir());
  assert.ok(info.roots.length > 0);
  const saved = fs.readFileSync(path.join(tmp, 'home', 'config.json'), 'utf8');
  assert.ok(!saved.includes(secret), 'the client never has the dashboard secret');
});

step('folders: create, list, rename, delete', async () => {
  await ctl.call(id, 'mkdir', { path: path.join(work, 'a') });
  await ctl.call(id, 'mv', { from: path.join(work, 'a'), to: path.join(work, 'b') });
  const { r } = await ctl.call(id, 'ls', { path: work });
  assert.deepEqual(r.entries.map((e) => [e.n, e.d]), [['b', true]]);
  assert.equal(r.parent, tmp);
  await ctl.call(id, 'rm', { path: path.join(work, 'b') });
  assert.equal(fs.readdirSync(work).length, 0);
  await assert.rejects(ctl.call(id, 'ls', { path: path.join(work, 'missing') }), /ENOENT/);
});

step('upload and download round-trip (1.2 MB, plus empty file)', async () => {
  for (const size of [1200003, 0]) {
    const data = nodeCrypto.randomBytes(size);
    const file = path.join(work, 'blob-' + size);
    await ctl.upload(id, file, { size, read: async (off, len) => data.subarray(off, off + len) });
    assert.ok(fs.readFileSync(file).equals(data), 'uploaded bytes match');
    assert.deepEqual(fs.readdirSync(work).filter((n) => n.includes('.part')), []);
    const parts = [];
    const meta = await ctl.download(id, file, { onChunk: (c) => parts.push(Buffer.from(c)) });
    assert.equal(meta.size, size);
    assert.ok(Buffer.concat(parts).equals(data), 'downloaded bytes match');
  }
});

step('run a command and stream its output', async () => {
  const { r } = await ctl.call(id, 'exec', { cmd: 'echo olá-from-reach && exit 3', cwd: work });
  const out = await collect(r.job);
  assert.match(out.text, /olá-from-reach/);
  assert.equal(out.code, 3);
  const tail = await ctl.call(id, 'tail', { job: r.job });
  assert.match(Buffer.from(tail.body).toString(), /olá-from-reach/);
  assert.equal(tail.r.running, false);
});

step('commands run in the requested folder', async () => {
  fs.writeFileSync(path.join(work, 'marker.txt'), 'x');
  const { r } = await ctl.call(id, 'exec', { cmd: win ? 'dir /b' : 'ls', cwd: work });
  assert.match((await collect(r.job)).text, /marker\.txt/);
  assert.equal((await ctl.call(id, 'resolve', { cwd: work, path: '..' })).r.path, tmp);
});

step('stdin reaches a running job, and kill stops one', async () => {
  const a = await ctl.call(id, 'exec', { cmd: win ? 'findstr x' : 'cat', cwd: work });
  const done = collect(a.r.job);
  await ctl.call(id, 'stdin', { job: a.r.job, eof: true }, Buffer.from('x-typed-on-phone\n'));
  assert.match((await done).text, /x-typed-on-phone/);

  const b = await ctl.call(id, 'exec', { cmd: win ? 'ping -n 60 127.0.0.1' : 'sleep 60', cwd: work });
  const killed = collect(b.r.job);
  await sleep(500);
  assert.equal((await ctl.call(id, 'jobs')).r.find((j) => j.job === b.r.job).running, true);
  await ctl.call(id, 'kill', { job: b.r.job });
  assert.notEqual((await killed).code, 0);
});

step('saved scripts persist on the machine', async () => {
  await ctl.call(id, 'scripts.set', { scripts: [{ name: 'hello', cmd: 'echo hi', cwd: work }] });
  assert.deepEqual((await ctl.call(id, 'scripts.get')).r, [{ name: 'hello', cmd: 'echo hi', cwd: work }]);
});

step('a machine joins with a pairing code', async () => {
  const second = reach(['pair', '--no-qr', '--name', 'paired box'], 'home2', { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  second.stdout.on('data', (d) => (out += d));
  await until(() => /[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/.test(out), 'pairing code');
  const code = out.match(/[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/)[0];
  assert.equal(await pairOffer({ mqttConnect: mqtt.connect, code, pub }), 'paired box');
  await until(() => online('paired box'), 'paired machine online');
  second.kill();
});

step('the dashboard program serves the page only to its own page, and can add its own computer', async () => {
  reach(['--no-open', '--port', String(PORT), '--name', 'dash box'], 'home3', { stdio: 'ignore' });
  await until(() => local('GET', '/').then((r) => r.status === 200 && /<title>reach<\/title>/.test(r.body), () => false), 'dashboard page');
  const ok = { 'x-reach': '1' };
  assert.equal((await local('GET', '/api/status')).status, 403, 'needs the page header');
  assert.equal((await local('GET', '/api/status', { ...ok, 'sec-fetch-site': 'cross-site' })).status, 403, 'other sites are refused');
  assert.equal((await local('GET', '/', { host: 'evil.example' })).status, 403, 'other host names are refused');
  assert.equal((await local('POST', '/api/enroll', {}, { p: pub })).status, 403, 'cannot enrol without the page header');
  assert.equal(JSON.parse((await local('GET', '/api/status', ok)).body).enrolled, '');
  assert.equal((await local('POST', '/api/enroll', ok, { p: pub })).status, 200);
  await until(() => online('dash box'), 'dashboard computer online');
  assert.equal(JSON.parse((await local('GET', '/api/status', ok)).body).enrolled, pub);
});

if (BIN)
  step('a client program downloaded from the dashboard joins by itself and holds no secret', async () => {
    const target = JSON.parse((await local('GET', '/api/status', { 'x-reach': '1' })).body).target;
    const res = await local('GET', `/api/client?target=${target}&p=${pub}`, { 'sec-fetch-site': 'same-origin' });
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(secret), 'no dashboard secret inside');
    const exe = path.join(tmp, 'reach-client' + (win ? '.exe' : ''));
    fs.writeFileSync(exe, res.body, { mode: 0o755 });
    const run = spawn(exe, ['--name', 'client box'], { env: { ...process.env, REACH_HOME: path.join(tmp, 'home4') }, stdio: 'ignore' });
    children.push(run);
    await until(() => online('client box'), 'stamped client online');
    const box = online('client box').id;
    const { r } = await ctl.call(box, 'exec', { cmd: 'echo from-client', cwd: work });
    assert.match((await collect(r.job, box)).text, /from-client/);
    run.kill();
  });

if (BIN)
  step('kit: prepared dashboard and client program, key erased once the page has claimed it', async () => {
    const dir = path.join(tmp, 'kit');
    const kit = reach(['kit', dir, '--targets', (win ? 'windows' : 'linux') + '-' + process.arch], 'home5', { stdio: 'ignore' });
    assert.equal(await new Promise((r) => kit.on('close', r)), 0);
    const exe = fs.readdirSync(dir).map((f) => path.join(dir, f))[0];
    assert.match(path.basename(exe), /^reach-client-/);
    const port = PORT + 1;
    reach(['--no-open', '--port', String(port), '--name', 'kit desktop'], 'home5', { stdio: 'ignore' });
    const call = async (method, name) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/${name}`, { method, headers: { 'x-reach': '1', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      return { status: res.status, ...(await res.json()) };
    };
    await until(() => call('GET', 'status').then((s) => s.pending === true, () => false), 'prepared dashboard');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/claim`, { method: 'POST' })).status, 403, 'other pages cannot take the key');
    const { secret: kitSecret } = await call('POST', 'claim');
    let list = [];
    const kitCtl = new Controller({ mqttConnect: mqtt.connect, secret: kitSecret, onMachines: (m) => (list = m) });
    await kitCtl.start();
    const run = spawn(exe, ['--name', 'kit client'], { env: { ...process.env, REACH_HOME: path.join(tmp, 'home6') }, stdio: 'ignore' });
    children.push(run);
    await until(() => ['kit desktop', 'kit client'].every((n) => list.some((m) => m.online && m.name === n)), 'kit computer and kit client online');
    kitCtl.stop();
    await call('POST', 'claimed');
    assert.equal((await call('GET', 'status')).pending, false);
    assert.equal((await call('POST', 'claim')).status, 404);
    assert.ok(!fs.readFileSync(path.join(tmp, 'home5', 'config.json'), 'utf8').includes(kitSecret), 'key erased from disk after claiming');
  });

step('knowing the dashboard address (what a client program holds) is not enough to control a machine', async () => {
  const base = await fleetBase(pub);
  const attacker = await newSecret();
  const spy = mqtt.connect(DEFAULT_BROKER);
  const seen = [];
  let agentPub;
  spy.on('message', (t, p) => (t.includes('/hello/') ? (agentPub = p.subarray(0, 65)) : seen.push(t)));
  await spy.subscribeAsync([`${base}/hello/${id}`, `${base}/${id}/re/+`], { qos: 1 });
  await spy.publishAsync(`${base}/who`, '');
  await until(() => agentPub, 'client public key');
  const key = await channelKey(attacker, new Uint8Array(agentPub));
  const topic = `${base}/${id}/to`;
  const f = 'c' + '0'.repeat(16);
  await spy.publishAsync(topic, Buffer.from(await seal(key, topic, { y: 'hello', f, c: 'x' })), { qos: 1 });
  await spy.publishAsync(topic, Buffer.from(await seal(key, topic, { y: 'req', f, s: 'x', n: 1, id: 'x', op: 'exec', a: { cmd: 'echo pwned > ' + path.join(work, 'pwned'), cwd: work } })), { qos: 1 });
  await sleep(3000);
  spy.end(true);
  assert.deepEqual(seen, [], 'the client did not answer');
  assert.equal(fs.existsSync(path.join(work, 'pwned')), false);

  let others = [];
  const other = new Controller({ mqttConnect: mqtt.connect, secret: attacker, onMachines: (m) => (others = m) });
  await other.start();
  await sleep(3000);
  other.stop();
  assert.equal(others.length, 0, 'another dashboard sees none of these machines');
});

step('a recorded command cannot be replayed', async () => {
  const topic = `${await fleetBase(pub)}/${id}/to`;
  const spy = mqtt.connect(DEFAULT_BROKER);
  const captured = [];
  spy.on('message', (_t, p) => captured.push(p));
  await spy.subscribeAsync(topic, { qos: 1 });
  const counter = path.join(work, 'counter');
  const { r } = await ctl.call(id, 'exec', { cmd: 'echo run >> ' + counter, cwd: work });
  await collect(r.job);
  await until(() => captured.length > 0, 'captured request');
  for (const p of [...captured]) await spy.publishAsync(topic, p, { qos: 1 });
  await sleep(2500);
  spy.end(true);
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/).length, 1);
});

let failed = false;
try {
  for (const [name, fn] of steps) {
    const t0 = Date.now();
    try {
      await fn();
      console.log(`ok    ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed = true;
      console.log(`FAIL  ${name}\n      ${String(e.stack || e).split('\n').join('\n      ')}`);
      break;
    }
  }
} finally {
  ctl?.stop();
  for (const c of children) c.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? '\nFAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
