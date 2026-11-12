#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import qrcode from 'qrcode-terminal';
import { Link, seal, unseal, channelKey, fleetBase, agentIdOf, newSecret, publicOf, checkPublic, checkBroker, newPairCode, pairWait, randId, b64u, CHUNK, DEFAULT_BROKER } from './docs/core.js';

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// In the standalone executables build.mjs embeds the dashboard files and package info as these globals.
const PACKED = typeof __REACH_ASSETS__ !== 'undefined' ? __REACH_ASSETS__ : null;
const ROOT = PACKED ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const PKG = PACKED ? __REACH_PKG__ : JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (PACKED) {
  // Set by the build banner for the bundled ws library; not meant for the commands we start.
  delete process.env.WS_NO_BUFFER_UTIL;
  delete process.env.WS_NO_UTF_8_VALIDATE;
}
const HOME_DIR = process.env.REACH_HOME || path.join(os.homedir(), '.reach');
const CONFIG = path.join(HOME_DIR, 'config.json');
const RELEASES = 'https://github.com/antoniolox1721/reach/releases/latest/download/';
const TARGETS = ['windows-x64', 'linux-x64', 'linux-arm64'];
const RING = 1024 * 1024;
const MAX_JOBS = 30;
const READ_WINDOW = 16;

// ---------- config ----------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${CONFIG}: ${e.message}`);
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-qr') flags.noQr = true;
    else if (a === '--no-open') flags.noOpen = true;
    else if (a === '--name' || a === '--broker' || a === '--port' || a === '--targets') flags[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') flags.help = true;
    else rest.push(a);
  }
  return { flags, rest };
}

const HELP = `reach ${PKG.version} - see and control your machines from your own dashboard

The dashboard program opens your password-protected dashboard. From there you download
client programs. A client program only puts its machine on your dashboard.

  reach                 dashboard program: open the dashboard / client program: go online
  reach kit [folder]    prepare everything: a new dashboard for this computer (you only choose the
                        password) and client programs for Windows and Linux in the folder
  reach pair            show a one-time code to add this machine to a dashboard, then stay online
  reach client          stay online without opening the dashboard (after this machine was added)
  reach name <name>     rename this machine

  --name <name>         name for this machine (saved)
  --broker <wss url>    use your own MQTT-over-WebSocket relay (saved)
  --port <number>       port for the local dashboard page (default 7700)
  --no-open             do not open the browser
  --no-qr               do not print QR codes
`;

// ---------- machine info ----------

function osLabel() {
  if (process.env.TERMUX_VERSION || (process.env.PREFIX || '').includes('com.termux')) return 'android';
  if (process.platform === 'linux' && /microsoft/i.test(os.release())) return 'wsl';
  return { win32: 'windows', darwin: 'mac' }[process.platform] || process.platform;
}

const ownTarget = () => `${{ win32: 'windows', darwin: 'macos' }[process.platform] || process.platform}-${process.arch}`;

function roots() {
  const out = [];
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') if (fs.existsSync(l + ':\\')) out.push(l + ':\\');
  } else {
    out.push('/');
  }
  for (const extra of [path.join(os.homedir(), 'storage', 'shared'), '/sdcard', '/mnt/c']) {
    try {
      fs.readdirSync(extra);
      out.push(extra);
    } catch {}
  }
  return out;
}

function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

// ---------- client: makes this machine reachable from the dashboard it belongs to ----------

class Reply {
  constructor(r, body) {
    this.r = r;
    this.body = body;
  }
}

async function startClient(cfg) {
  const pubRaw = b64u.dec(publicOf(cfg.asecret));
  const aid = await agentIdOf(pubRaw);
  // Only the holder of the dashboard secret can derive this key, so only the dashboard can send us requests.
  const key = await channelKey(cfg.asecret, b64u.dec(checkPublic(cfg.dpub)));
  const base = await fleetBase(cfg.dpub);
  const T = { hello: `${base}/hello/${aid}`, to: `${base}/${aid}/to`, out: `${base}/${aid}/out`, who: `${base}/who`, re: (f) => `${base}/${aid}/re/${f}` };
  const boot = randId(6);
  const sessions = new Map();
  const reads = new Map();
  const writes = new Map();
  const jobs = new Map();
  const timers = [];
  let jobSeq = 0;

  const info = () => ({
    id: aid,
    name: cfg.name,
    host: os.hostname(),
    os: osLabel(),
    arch: process.arch,
    user: userName(),
    home: os.homedir(),
    roots: roots(),
    sep: path.sep,
    cpus: os.cpus().length,
    mem: os.totalmem(),
    version: PKG.version,
  });

  // Presence carries our public key in the clear so the dashboard can derive the shared key.
  const hello = async (y) => {
    const sealed = await seal(key, T.hello, { y, name: cfg.name, os: osLabel(), host: os.hostname(), boot, ts: Date.now() });
    const out = new Uint8Array(65 + sealed.length);
    out.set(pubRaw);
    out.set(sealed, 65);
    return out;
  };
  let lastAnnounce = 0;
  const announce = (force) => {
    if (!force && Date.now() - lastAnnounce < 1000) return;
    lastAnnounce = Date.now();
    link.publish(T.hello, () => hello('pres'), 0).catch(() => {});
  };

  const link = Link.open({
    mqttConnect: mqtt.connect,
    broker: cfg.broker,
    subscribe: [T.who, T.to],
    will: { topic: T.hello, payload: Buffer.from(await hello('bye')) },
    onStatus: (s) => {
      console.log(new Date().toLocaleTimeString() + (s === 'online' ? '  connected' : '  disconnected, retrying...'));
      if (s === 'online') announce(true);
    },
    route: async (topic, payload) => {
      if (topic === T.who) return announce(false);
      const m = await unseal(key, topic, payload);
      if (m) handle(m.h, m.body);
    },
  });
  timers.push(setInterval(() => announce(true), 20000));

  const resolveP = (p) => {
    if (!p) return os.homedir();
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
    return path.resolve(p);
  };

  const ops = {
    info: () => info(),

    async ls({ path: p }) {
      const dir = resolveP(p);
      const names = await fsp.readdir(dir, { withFileTypes: true });
      const truncated = names.length > 5000;
      const entries = await Promise.all(
        names.slice(0, 5000).map(async (d) => {
          const e = { n: d.name, d: d.isDirectory(), s: 0, m: 0 };
          try {
            const st = await fsp.stat(path.join(dir, d.name));
            e.d = st.isDirectory();
            e.s = st.size;
            e.m = st.mtimeMs;
          } catch {}
          return e;
        })
      );
      const parent = path.dirname(dir);
      return { path: dir, parent: parent === dir ? null : parent, sep: path.sep, entries, truncated };
    },

    async resolve({ cwd, path: p }) {
      const target = !p || p.startsWith('~') ? resolveP(p) : path.resolve(resolveP(cwd), p);
      if (!(await fsp.stat(target)).isDirectory()) throw new Error('Not a folder: ' + target);
      return { path: target };
    },

    async mkdir({ path: p }) {
      await fsp.mkdir(resolveP(p));
    },

    async rm({ path: p }) {
      const target = resolveP(p);
      if (path.dirname(target) === target || target === os.homedir()) throw new Error('Refusing to delete ' + target);
      await fsp.rm(target, { recursive: true });
    },

    async mv({ from, to }) {
      const a = resolveP(from);
      const b = resolveP(to);
      if (fs.existsSync(b)) throw new Error('Already exists: ' + b);
      try {
        await fsp.rename(a, b);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(a, b, { recursive: true, errorOnExist: true });
        await fsp.rm(a, { recursive: true });
      }
    },

    // Streams the file as 'ev' messages; the reader acks so we never run far ahead of it.
    async read({ path: p }, _body, ctx) {
      const file = resolveP(p);
      const fh = await fsp.open(file, 'r');
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        throw new Error('Not a file: ' + file);
      }
      const x = { acked: -1, cancelled: false, wake: null, touched: Date.now() };
      reads.set(ctx.id, x);
      (async () => {
        try {
          const buf = Buffer.alloc(CHUNK);
          for (let seq = 0, off = 0; ; seq++) {
            while (seq - x.acked > READ_WINDOW && !x.cancelled) {
              if (Date.now() - x.touched > 60000) x.cancelled = true;
              else await new Promise((r) => ((x.wake = r), setTimeout(r, 1000)));
            }
            if (x.cancelled) break;
            const { bytesRead } = await fh.read(buf, 0, CHUNK, off);
            off += bytesRead;
            const last = bytesRead < CHUNK || off >= st.size;
            await ctx.ev({ seq, last }, buf.subarray(0, bytesRead));
            if (last) break;
          }
        } catch {
          // The reader notices the stall and reports it.
        } finally {
          reads.delete(ctx.id);
          await fh.close().catch(() => {});
        }
      })();
      return { size: st.size, mtime: st.mtimeMs };
    },

    ack({ x, seq }) {
      const r = reads.get(x);
      if (!r) return;
      r.acked = Math.max(r.acked, seq);
      r.touched = Date.now();
      r.wake?.();
    },

    cancel({ x }) {
      const r = reads.get(x);
      if (r) r.cancelled = true;
      r?.wake?.();
    },

    async wopen({ path: p }) {
      const file = resolveP(p);
      const x = randId(8);
      const tmp = file + '.reach-' + x + '.part';
      const fh = await fsp.open(tmp, 'wx');
      writes.set(x, { file, tmp, fh, seq: 0, chain: Promise.resolve(), touched: Date.now() });
      return { x };
    },

    wchunk({ x, seq }, body) {
      const w = writes.get(x);
      if (!w) throw new Error('Upload not found.');
      if (seq !== w.seq) throw new Error('Upload out of order.');
      w.seq++;
      w.touched = Date.now();
      const data = Buffer.from(body);
      w.chain = w.chain.then(() => w.fh.writeFile(data));
      return w.chain;
    },

    async wclose({ x }) {
      const w = writes.get(x);
      if (!w) throw new Error('Upload not found.');
      writes.delete(x);
      try {
        await w.chain;
        await w.fh.close();
        await fsp.rename(w.tmp, w.file);
      } catch (e) {
        await w.fh.close().catch(() => {});
        await fsp.rm(w.tmp, { force: true });
        throw e;
      }
    },

    wabort: ({ x }) => abortWrite(x),

    async exec({ cmd, cwd }) {
      if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('Empty command.');
      const dir = resolveP(cwd);
      if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Not a folder: ' + dir);
      return { job: startJob(cmd, dir).id };
    },

    jobs: () => [...jobs.values()].map((j) => ({ job: j.id, cmd: j.cmd, cwd: j.cwd, started: j.started, running: j.running, code: j.code })),

    tail({ job, max = CHUNK * 4 }) {
      const j = jobs.get(job);
      if (!j) throw new Error('That job is gone.');
      const end = Math.max(j.cursor, j.start);
      const from = Math.max(j.start, end - Math.min(max, CHUNK * 4));
      return new Reply({ from, end, running: j.running || !j.exitSent, code: j.code }, j.buf.subarray(from - j.start, end - j.start));
    },

    stdin({ job, eof }, body) {
      const j = jobs.get(job);
      if (!j?.running) throw new Error('That job is not running.');
      if (body?.length) j.child.stdin.write(Buffer.from(body));
      if (eof) j.child.stdin.end();
    },

    kill({ job }) {
      const j = jobs.get(job);
      if (j?.running) killJob(j);
    },

    'scripts.get': () => cfg.scripts || [],

    'scripts.set'({ scripts }) {
      if (!Array.isArray(scripts)) throw new Error('Bad scripts list.');
      cfg.scripts = scripts.slice(0, 200).map((s) => ({ name: String(s.name || '').slice(0, 80), cmd: String(s.cmd || ''), cwd: String(s.cwd || '') }));
      saveConfig(cfg);
    },
  };

  async function abortWrite(x) {
    const w = writes.get(x);
    if (!w) return;
    writes.delete(x);
    await w.chain.catch(() => {});
    await w.fh.close().catch(() => {});
    await fsp.rm(w.tmp, { force: true });
  }

  function startJob(cmd, cwd) {
    const win = process.platform === 'win32';
    // Windows: switch the console to UTF-8 first, then hand the command to a second cmd.exe through a
    // delayed-expansion variable so the outer shell never re-parses the user's quotes or operators.
    const child = win
      ? spawn('cmd.exe', ['/v:on', '/d', '/s', '/c', '"chcp 65001>nul & cmd.exe /d /s /c "!REACH_CMD!""'], { cwd, windowsVerbatimArguments: true, windowsHide: true, env: { ...process.env, REACH_CMD: cmd } })
      : spawn(process.env.SHELL || 'sh', ['-c', cmd], { cwd, detached: true });
    const j = { id: 'j' + ++jobSeq + boot, cmd, cwd, started: Date.now(), child, buf: Buffer.alloc(0), start: 0, cursor: 0, running: true, code: null, exitSent: false };
    jobs.set(j.id, j);
    const add = (d) => {
      j.buf = Buffer.concat([j.buf, d]);
      if (j.buf.length > RING) {
        const cut = j.buf.length - RING;
        j.buf = j.buf.subarray(cut);
        j.start += cut;
      }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      add(Buffer.from('reach: could not start: ' + e.message + '\n'));
      finish(-1);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : -1)));
    const finish = (code) => {
      if (!j.running) return;
      j.running = false;
      j.code = code;
      const done = [...jobs.values()].filter((o) => !o.running);
      for (const old of done.slice(0, Math.max(0, jobs.size - MAX_JOBS))) jobs.delete(old.id);
    };
    return j;
  }

  function killJob(j) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(j.child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      return;
    }
    const signal = (s) => {
      try {
        process.kill(-j.child.pid, s);
      } catch {}
    };
    signal('SIGTERM');
    setTimeout(() => j.running && signal('SIGKILL'), 3000).unref();
  }

  // Publishes job output at a bounded rate; anything it skips stays readable through 'tail'.
  timers.push(
    setInterval(() => {
      if (!link.connected) return;
      for (const j of jobs.values()) {
        if (link.unacked > 8) return;
        const end = j.start + j.buf.length;
        if (j.cursor < j.start) j.cursor = j.start;
        if (j.cursor < end) {
          const chunk = j.buf.subarray(j.cursor - j.start, Math.min(end, j.cursor + CHUNK) - j.start);
          link.send(key, T.out, { y: 'out', job: j.id, off: j.cursor }, chunk).catch(() => {});
          j.cursor += chunk.length;
        } else if (!j.running && !j.exitSent) {
          j.exitSent = true;
          link.send(key, T.out, { y: 'exit', job: j.id, code: j.code, end }).catch(() => {});
        }
      }
    }, 100)
  );

  // Drop uploads whose sender disappeared.
  timers.push(
    setInterval(() => {
      for (const [x, w] of writes) if (Date.now() - w.touched > 120000) abortWrite(x);
    }, 30000)
  );

  function handle(h, body) {
    if (typeof h.f !== 'string' || !/^c[0-9a-f]{16}$/.test(h.f)) return;
    const to = T.re(h.f);
    if (h.y === 'hello') {
      const s = randId(12);
      sessions.set(s, { f: h.f, n: 0 });
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
      link.send(key, to, { y: 'welcome', c: h.c, s, info: info() }).catch(() => {});
      return;
    }
    if (h.y !== 'req') return;
    const sess = sessions.get(h.s);
    if (!sess || sess.f !== h.f) {
      link.send(key, to, { y: 'nosession', id: h.id }).catch(() => {});
      return;
    }
    // Each request carries a strictly increasing counter, so a recorded request cannot be replayed.
    if (!Number.isInteger(h.n) || h.n <= sess.n) return;
    sess.n = h.n;
    const ctx = { id: h.id, ev: (extra, b) => link.send(key, to, { y: 'ev', id: h.id, ...extra }, b) };
    let result;
    try {
      if (!Object.hasOwn(ops, h.op)) throw new Error('Unknown operation: ' + h.op);
      result = Promise.resolve(ops[h.op](h.a || {}, body, ctx));
    } catch (e) {
      result = Promise.reject(e);
    }
    result
      .then((r) => (r instanceof Reply ? link.send(key, to, { y: 'res', id: h.id, ok: true, r: r.r }, r.body) : link.send(key, to, { y: 'res', id: h.id, ok: true, r: r ?? null })))
      .catch((e) => link.send(key, to, { y: 'res', id: h.id, ok: false, e: String(e?.message || e) }))
      .catch(() => {});
  }

  return {
    dpub: cfg.dpub,
    async stop() {
      for (const t of timers) clearInterval(t);
      for (const j of jobs.values()) if (j.running) killJob(j);
      await Promise.race([link.publish(T.hello, () => hello('bye'), 0).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      link.close();
    },
  };
}

// ---------- client programs: this executable with a dashboard's public address stamped onto its end ----------

const STAMP = /\n#REACH-CLIENT(#p=[A-Za-z0-9_-]{87}(?:&b=[A-Za-z0-9_%.~+-]+)?)#END#\n$/;

function findStamp(data) {
  const m = STAMP.exec(data.subarray(Math.max(0, data.length - 1024)).toString('latin1'));
  if (!m) return null;
  const p = new URLSearchParams(m[1].slice(1));
  return { pub: checkPublic(p.get('p')), broker: checkBroker(p.get('b') || ''), length: Buffer.byteLength(m[0], 'latin1') };
}

function ownStamp() {
  if (!PACKED) return null;
  const fd = fs.openSync(process.execPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return findStamp(buf);
  } finally {
    fs.closeSync(fd);
  }
}

// The stamp holds nothing secret: it only says which dashboard the machine should appear on.
function stampClient(program, pub, broker) {
  const old = findStamp(program);
  if (old) program = program.subarray(0, program.length - old.length);
  const link = '#' + new URLSearchParams({ p: checkPublic(pub), ...(broker ? { b: checkBroker(broker) } : {}) });
  const stamp = Buffer.from(`\n#REACH-CLIENT${link}#END#\n`, 'latin1');
  if (!STAMP.test(stamp.toString('latin1'))) throw new Error('That relay address cannot be stamped.');
  return Buffer.concat([program, stamp]);
}

const programCache = new Map();
async function programFor(target) {
  if (!TARGETS.includes(target)) throw new Error('Unknown system: ' + target);
  if (PACKED && target === ownTarget()) return fs.readFileSync(process.execPath);
  if (!programCache.has(target)) {
    const url = `${RELEASES}reach-dashboard-${target}${target.startsWith('windows') ? '.exe' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url} (${res.status}).`);
    programCache.set(target, Buffer.from(await res.arrayBuffer()));
  }
  return programCache.get(target);
}

// ---------- dashboard program: serves the dashboard page to this computer only ----------

function serveDashboard(cfg, port, state) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const docs = path.join(ROOT, 'docs');
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (d) => ((data += d), data.length > 4096 && reject(new Error('too large'))));
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (e) {
          reject(e);
        }
      });
    });

  const api = async (req, res, url) => {
    const name = url.pathname.slice(5);
    if (name === 'client' && req.method === 'GET') {
      // The page starts this as a normal download. It returns a program that holds no secret.
      const target = url.searchParams.get('target');
      const data = stampClient(await programFor(target), url.searchParams.get('p'), url.searchParams.get('b') || '');
      const file = `reach-client-${target}${target.startsWith('windows') ? '.exe' : ''}`;
      return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' }).end(data);
    }
    // Everything else changes this machine, so it must come from our own page (a custom header cannot be sent cross-site).
    if (req.headers['x-reach'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (name === 'status' && req.method === 'GET') {
      return json(res, 200, { name: cfg.name, os: osLabel(), version: PKG.version, target: ownTarget(), targets: TARGETS, enrolled: state.client?.dpub || '', pairCode: state.pairCode || '', pending: !!cfg.pending, broker: cfg.broker || '' });
    }
    // A dashboard prepared by "reach kit" waits here until the page has locked it with the user's password.
    if (name === 'claim' && req.method === 'POST') {
      if (!cfg.pending) return json(res, 404, { error: 'No prepared dashboard is waiting.' });
      return json(res, 200, { secret: cfg.pending, broker: cfg.broker || '' });
    }
    if (name === 'claimed' && req.method === 'POST') {
      delete cfg.pending;
      saveConfig(cfg);
      return json(res, 200, { ok: true });
    }
    if (name === 'enroll' && req.method === 'POST') {
      const body = await readBody(req);
      await state.enroll(checkPublic(body.p), checkBroker(body.b || ''));
      return json(res, 200, { ok: true });
    }
    if (name === 'pair' && req.method === 'POST') return json(res, 200, { code: state.startPairing() });
    return json(res, 404, { error: 'not found' });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // Refuse other sites reaching this server through the browser (cross-site requests, DNS rebinding).
    const site = req.headers['sec-fetch-site'];
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || (site && site !== 'same-origin' && !(site === 'none' && !url.pathname.startsWith('/api/')))) {
      return res.writeHead(403).end();
    }
    if (url.pathname.startsWith('/api/')) return api(req, res, url).catch((e) => json(res, 400, { error: String(e.message || e) }));
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const send = (data) => res.writeHead(200, { 'content-type': types[path.extname(name)], 'cache-control': 'no-store' }).end(data);
    if (PACKED) return Object.hasOwn(PACKED, name) ? send(PACKED[name]) : res.writeHead(404).end();
    const file = path.join(docs, name);
    if (!file.startsWith(docs + path.sep) || !types[path.extname(file)]) return res.writeHead(404).end();
    fs.readFile(file, (e, data) => (e ? res.writeHead(404).end() : send(data)));
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is busy. The dashboard program is probably already running: open http://127.0.0.1:${port}/`) : e));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {}
}

// ---------- kit: a prepared dashboard plus client programs for it ----------

async function makeKit(cfg, folder, targets) {
  for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`Unknown system "${t}". Choose from: ${TARGETS.join(', ')}`);
  // The new dashboard key waits in this computer's private config until the dashboard page locks it with a password.
  if (!cfg.pending) cfg.pending = await newSecret();
  const pub = publicOf(cfg.pending);
  cfg.dpub = pub;
  saveConfig(cfg);
  fs.mkdirSync(folder, { recursive: true });
  console.log('Dashboard prepared for this computer.\n');
  for (const t of targets) {
    const file = path.join(folder, `reach-client-${t}${t.startsWith('windows') ? '.exe' : ''}`);
    process.stdout.write(`Making ${file} ... `);
    fs.writeFileSync(file, stampClient(await programFor(t), pub, cfg.broker), { mode: 0o755 });
    console.log('done');
  }
  console.log('\nNext:\n  1. Start the dashboard program on this computer and choose your password. This computer is added by itself.');
  console.log('  2. Run a client program on any other computer. It appears on your dashboard by itself.');
}

// ---------- cli ----------

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0] || 'up';
  if (flags.help || cmd === 'help') return console.log(HELP);
  if (!['up', 'pair', 'client', 'name', 'kit'].includes(cmd)) throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);

  const cfg = loadConfig();
  if (flags.name) cfg.name = flags.name;
  if (flags.broker !== undefined) cfg.broker = checkBroker(flags.broker);
  if (cmd === 'name') {
    if (!rest[1]) throw new Error('Usage: reach name <name>');
    cfg.name = rest.slice(1).join(' ');
  }
  if (!cfg.name) cfg.name = os.hostname();
  if (!cfg.asecret) cfg.asecret = await newSecret();
  if (cfg.broker === DEFAULT_BROKER) cfg.broker = '';
  checkBroker(cfg.broker);
  const stamp = ownStamp();
  if (stamp) {
    cfg.dpub = stamp.pub;
    cfg.broker = stamp.broker;
  }
  if (cfg.dpub) checkPublic(cfg.dpub);
  saveConfig(cfg);
  if (cmd === 'name') return console.log(`This machine is now called "${cfg.name}".`);
  if (cmd === 'kit') {
    if (stamp) throw new Error('This is a client program. Use the dashboard program to make a kit.');
    return makeKit(cfg, path.resolve(rest[1] || '.'), (flags.targets || 'windows-x64,linux-x64').split(','));
  }

  const state = {
    client: null,
    pairCode: '',
    async enroll(pub, broker) {
      if (state.client?.dpub === pub && (cfg.broker || '') === broker) return;
      await state.client?.stop();
      cfg.dpub = pub;
      cfg.broker = broker;
      saveConfig(cfg);
      state.client = await startClient(cfg);
      console.log(`"${cfg.name}" is now on the dashboard.`);
    },
    startPairing() {
      if (state.pairCode) return state.pairCode;
      const code = (state.pairCode = newPairCode());
      pairWait({ mqttConnect: mqtt.connect, broker: cfg.broker, code, name: cfg.name })
        .promise.then((got) => state.enroll(got.pub, got.broker))
        .catch((e) => console.error('Pairing failed: ' + e.message))
        .finally(() => (state.pairCode = ''));
      return code;
    },
  };
  const shutdown = async () => {
    await state.client?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (cfg.dpub) state.client = await startClient(cfg);

  // A stamped program is a client and nothing else: it never opens a dashboard.
  if (stamp || cmd === 'client') {
    if (!cfg.dpub) throw new Error('This machine is not on a dashboard yet. Run "reach pair", or use a client program downloaded from your dashboard.');
    return console.log(`reach ${PKG.version}: "${cfg.name}" is on your dashboard while this stays open. Ctrl+C stops it.`);
  }

  if (cmd === 'pair') {
    const code = state.startPairing();
    console.log(`\nTo put "${cfg.name}" on your dashboard, open the dashboard, choose "Add a machine" and enter this code:\n\n    ${code}\n`);
    if (!flags.noQr) {
      console.log('or scan this with the phone that has your dashboard:\n');
      qrcode.generate(PKG.homepage + '#pair=' + code, { small: true }, (q) => console.log(q.replace(/^/gm, '  ')));
    }
    return console.log('Waiting. Leave this open: afterwards the machine stays on the dashboard for as long as this runs.\n');
  }

  const port = Number(flags.port) || 7700;
  await serveDashboard(cfg, port, state);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`reach ${PKG.version} dashboard: ${url}\n\nIt opens in your browser and asks for your password. Keep this window open while you use it.`);
  if (cfg.dpub) console.log(`"${cfg.name}" is also on the dashboard while this stays open.`);
  if (!flags.noOpen) openBrowser(url);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
