// End-to-end check against the real relay: starts an agent, then drives it like the dashboard does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
const { Controller, newKey, deriveKeys, pairOffer, DEFAULT_BROKER } = await import('../docs/core.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-test-'));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const win = process.platform === 'win32';
// REACH_BIN=<path to a built executable> tests that instead of the source.
const reach = (args, opts) => (process.env.REACH_BIN ? spawn(path.resolve(process.env.REACH_BIN), args, opts) : spawn(process.execPath, [path.join(root, 'reach.js'), ...args], opts));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return;
  throw new Error('timed out waiting for ' + what);
};

const agent = reach(['new', '--no-qr', '--name', 'test box'], { env: { ...process.env, REACH_HOME: home }, stdio: 'ignore' });
let failed = false;
const steps = [];
const step = (name, fn) => steps.push([name, fn]);

let ctl, id, machines = [];
const collect = async (job) => {
  let text = '', code;
  const stop = ctl.watchJob(id, job, (h, b) => (h.y === 'exit' ? (code = h.code) : (text += Buffer.from(b).toString())));
  await until(() => code !== undefined, 'job exit');
  stop();
  return { text, code };
};

step('machine appears on the dashboard', async () => {
  await until(() => fs.existsSync(path.join(home, 'config.json')), 'agent config');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  ctl = new Controller({ mqttConnect: mqtt.connect, key: cfg.key, onMachines: (m) => (machines = m) });
  await ctl.start();
  await until(() => machines.some((m) => m.online && m.name === 'test box'), 'presence');
  id = machines[0].id;
  const info = await ctl.info(id);
  assert.equal(info.home, os.homedir());
  assert.ok(info.roots.length > 0);
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
  const res = await ctl.call(id, 'resolve', { cwd: work, path: '..' });
  assert.equal(res.r.path, tmp);
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).scripts[0].name, 'hello');
});

step('a new machine joins with a pairing code, another with a key file', async () => {
  const home2 = path.join(tmp, 'home2');
  const second = reach(['--no-qr', '--name', 'paired box'], { env: { ...process.env, REACH_HOME: home2 }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  second.stdout.on('data', (d) => (out += d));
  try {
    await until(() => /[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/.test(out), 'pairing code');
    const code = out.match(/[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/)[0];
    assert.equal(await pairOffer({ mqttConnect: mqtt.connect, code, secret: { key: ctl.key, broker: '' } }), 'paired box');
    await until(() => machines.some((m) => m.online && m.name === 'paired box'), 'paired machine online', 30000);
  } finally {
    second.kill();
  }

  const dir3 = path.join(tmp, 'usb');
  fs.mkdirSync(dir3);
  fs.writeFileSync(path.join(dir3, 'reach.key'), '#k=' + ctl.key + '\n');
  const third = reach(['join', path.join(dir3, 'reach.key'), '--no-qr', '--name', 'keyfile box'], { env: { ...process.env, REACH_HOME: path.join(tmp, 'home3') }, stdio: 'ignore' });
  try {
    await until(() => machines.some((m) => m.online && m.name === 'keyfile box'), 'key file machine online', 30000);
  } finally {
    third.kill();
  }
});

if (process.env.REACH_BIN)
  step('a personal copy of the executable joins by itself', async () => {
    const dir = path.join(tmp, 'personal');
    fs.mkdirSync(dir);
    const made = spawn(path.resolve(process.env.REACH_BIN), ['personal'], { cwd: dir, env: { ...process.env, REACH_HOME: home }, stdio: 'ignore' });
    await new Promise((r) => made.on('close', r));
    const exe = path.join(dir, 'my-' + path.basename(process.env.REACH_BIN));
    assert.ok(fs.existsSync(exe), 'personal copy written');
    const run = spawn(exe, ['--no-qr', '--name', 'personal box'], { cwd: dir, env: { ...process.env, REACH_HOME: path.join(tmp, 'home4') }, stdio: 'ignore' });
    try {
      await until(() => machines.some((m) => m.online && m.name === 'personal box'), 'personal copy online', 30000);
      const box = machines.find((m) => m.name === 'personal box');
      const { r } = await ctl.call(box.id, 'exec', { cmd: 'echo from-personal', cwd: work });
      let text = '';
      const stop = ctl.watchJob(box.id, r.job, (h, b) => h.y === 'out' && (text += Buffer.from(b).toString()));
      await until(() => /from-personal/.test(text), 'command output from the personal copy');
      stop();
    } finally {
      run.kill();
    }
  });

step('a different key sees nothing and cannot command the machine', async () => {
  let seen = [];
  const other = new Controller({ mqttConnect: mqtt.connect, key: newKey(), onMachines: (m) => (seen = m) });
  await other.start();
  await sleep(4000);
  assert.equal(seen.length, 0);
  other.stop();

  // Same relay channel, wrong encryption key: the agent must ignore it.
  const real = await deriveKeys(ctl.key);
  const forged = new Controller({ mqttConnect: mqtt.connect, key: newKey() });
  await forged.start();
  forged.link.keys = { enc: forged.link.keys.enc, base: real.base };
  await assert.rejects(forged.call(id, 'exec', { cmd: 'echo pwned > ' + path.join(work, 'pwned'), cwd: work }), /did not answer/);
  forged.stop();
  assert.equal(fs.existsSync(path.join(work, 'pwned')), false);
});

step('a recorded command cannot be replayed', async () => {
  const keys = await deriveKeys(ctl.key);
  const topic = keys.base + '/to/' + id;
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
  agent.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nFAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
