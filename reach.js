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

if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;
const { Link, deriveKeys, newKey, parseKeyInput, randId, CHUNK, DEFAULT_BROKER } = await import('./docs/core.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const HOME_DIR = process.env.REACH_HOME || path.join(os.homedir(), '.reach');
const CONFIG = path.join(HOME_DIR, 'config.json');
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
    else if (a === '--name' || a === '--broker' || a === '--dashboard') flags[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') flags.help = true;
    else rest.push(a);
  }
  return { flags, rest };
}

const HELP = `reach ${PKG.version} - control your machines from any of your machines

  reach                 put this machine online (creates your key on first run)
  reach join <key>      add this machine using the key (or dashboard link) from another one
  reach link            show the dashboard link, QR code and join command again
  reach ui [port]       serve the dashboard from this machine instead of the public page
  reach name <name>     rename this machine
  reach rekey           replace the key (every other machine must join again)

  --name <name>         name for this machine (saved)
  --broker <wss url>    use your own MQTT-over-WebSocket relay (saved)
  --dashboard <url>     dashboard address to print in links (saved)
  --no-qr               do not print the QR code
`;

function dashboardLink(cfg, base) {
  const p = new URLSearchParams({ k: cfg.key });
  if (cfg.broker) p.set('b', cfg.broker);
  return (base || cfg.dashboard || PKG.homepage) + '#' + p.toString();
}

function printAccess(cfg, noQr) {
  const link = dashboardLink(cfg);
  console.log('\nOpen the dashboard on any device (scan with your phone):\n\n  ' + link + '\n');
  if (!noQr) qrcode.generate(link, { small: true }, (q) => console.log(q.replace(/^/gm, '  ')));
  console.log('Add another machine:\n\n  npx github:antoniolox1721/reach join ' + cfg.key + (cfg.broker ? ' --broker ' + cfg.broker : '') + '\n');
  console.log('Keep the key secret. Anyone who has it can read files and run commands on every machine.\n');
}

// ---------- machine info ----------

function osLabel() {
  if (process.env.TERMUX_VERSION || (process.env.PREFIX || '').includes('com.termux')) return 'android';
  if (process.platform === 'linux' && /microsoft/i.test(os.release())) return 'wsl';
  return { win32: 'windows', darwin: 'mac' }[process.platform] || process.platform;
}

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

// ---------- agent ----------

async function runAgent(cfg, flags) {
  const keys = await deriveKeys(cfg.key);
  const boot = randId(6);
  const sessions = new Map();
  const reads = new Map();
  const writes = new Map();
  const jobs = new Map();
  let jobSeq = 0;

  const presence = (y) => ({ y, f: cfg.id, id: cfg.id, name: cfg.name, os: osLabel(), host: os.hostname(), boot, ts: Date.now() });
  const info = () => ({
    id: cfg.id,
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

  const link = await Link.open({
    mqttConnect: mqtt.connect,
    broker: cfg.broker,
    keys,
    subscribe: ['who', 'to/' + cfg.id],
    will: { suffix: 'pres', header: presence('bye') },
    onStatus: (s) => {
      console.log(new Date().toLocaleTimeString() + (s === 'online' ? '  connected' : '  disconnected, retrying...'));
      if (s === 'online') announce();
    },
  });
  const announce = () => link.send('pres', presence('pres'), null, 0).catch(() => {});
  setInterval(announce, 20000);
  link.on('who', announce);

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
  setInterval(() => {
    if (!link.connected) return;
    for (const j of jobs.values()) {
      if (link.unacked > 8) return;
      const end = j.start + j.buf.length;
      if (j.cursor < j.start) j.cursor = j.start;
      if (j.cursor < end) {
        const chunk = j.buf.subarray(j.cursor - j.start, Math.min(end, j.cursor + CHUNK) - j.start);
        link.send('out/' + cfg.id, { y: 'out', f: cfg.id, job: j.id, off: j.cursor }, chunk).catch(() => {});
        j.cursor += chunk.length;
      } else if (!j.running && !j.exitSent) {
        j.exitSent = true;
        link.send('out/' + cfg.id, { y: 'exit', f: cfg.id, job: j.id, code: j.code, end }).catch(() => {});
      }
    }
  }, 100);

  // Drop uploads whose sender disappeared.
  setInterval(() => {
    for (const [x, w] of writes) if (Date.now() - w.touched > 120000) abortWrite(x);
  }, 30000);

  link.on('to/' + cfg.id, (h, body) => {
    if (typeof h.f !== 'string') return;
    const to = 'to/' + h.f;
    if (h.y === 'hello') {
      const s = randId(12);
      sessions.set(s, { f: h.f, n: 0 });
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
      link.send(to, { y: 'welcome', f: cfg.id, c: h.c, s, info: info() }).catch(() => {});
      return;
    }
    if (h.y !== 'req') return;
    const sess = sessions.get(h.s);
    if (!sess || sess.f !== h.f) {
      link.send(to, { y: 'nosession', f: cfg.id, id: h.id }).catch(() => {});
      return;
    }
    // Each request carries a strictly increasing counter, so a recorded request cannot be replayed.
    if (!Number.isInteger(h.n) || h.n <= sess.n) return;
    sess.n = h.n;
    const ctx = { id: h.id, ev: (extra, b) => link.send(to, { y: 'ev', f: cfg.id, id: h.id, ...extra }, b) };
    let result;
    try {
      if (!Object.hasOwn(ops, h.op)) throw new Error('Unknown operation: ' + h.op);
      result = Promise.resolve(ops[h.op](h.a || {}, body, ctx));
    } catch (e) {
      result = Promise.reject(e);
    }
    result
      .then((r) => (r instanceof Reply ? link.send(to, { y: 'res', f: cfg.id, id: h.id, ok: true, r: r.r }, r.body) : link.send(to, { y: 'res', f: cfg.id, id: h.id, ok: true, r: r ?? null })))
      .catch((e) => link.send(to, { y: 'res', f: cfg.id, id: h.id, ok: false, e: String(e?.message || e) }))
      .catch(() => {});
  });

  const shutdown = () => {
    for (const j of jobs.values()) if (j.running) killJob(j);
    link.send('pres', presence('bye'), null, 0).catch(() => {});
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`reach ${PKG.version}: "${cfg.name}" is going online. Leave this running. Ctrl+C stops it.`);
  printAccess(cfg, flags.noQr);
}

class Reply {
  constructor(r, body) {
    this.r = r;
    this.body = body;
  }
}

// ---------- local dashboard ----------

function serveUi(cfg, port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const docs = path.join(ROOT, 'docs');
  http
    .createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(docs, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(docs + path.sep) || !types[path.extname(file)]) return res.writeHead(404).end();
      fs.readFile(file, (e, data) => {
        if (e) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-store' }).end(data);
      });
    })
    .listen(port, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${port}/`;
      console.log('Dashboard on this machine only:\n\n  ' + (cfg.key ? dashboardLink(cfg, base) : base) + '\n');
    });
}

// ---------- cli ----------

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0] || 'up';
  if (flags.help || cmd === 'help') return console.log(HELP);

  const cfg = loadConfig();
  let dirty = false;
  const set = (k, v) => {
    if (v !== undefined && cfg[k] !== v) {
      cfg[k] = v;
      dirty = true;
    }
  };
  set('name', flags.name);
  set('broker', flags.broker);
  set('dashboard', flags.dashboard);
  if (!cfg.id) set('id', 'm' + randId(6));
  if (!cfg.name) set('name', os.hostname());

  if (cmd === 'join') {
    const { key, broker } = parseKeyInput(rest[1]);
    await deriveKeys(key);
    set('key', key);
    if (broker) set('broker', broker);
  } else if (cmd === 'rekey') {
    set('key', newKey());
  } else if (cmd === 'name') {
    if (!rest[1]) throw new Error('Usage: reach name <name>');
    set('name', rest.slice(1).join(' '));
  } else if (cmd === 'up' && !cfg.key) {
    set('key', newKey());
  }
  if (cfg.broker === DEFAULT_BROKER) set('broker', '');
  if (dirty) saveConfig(cfg);

  if (cmd === 'up' || cmd === 'join') return runAgent(cfg, flags);
  if (cmd === 'ui') return serveUi(cfg, Number(rest[1]) || 7700);
  if (cmd === 'name') return console.log(`This machine is now called "${cfg.name}". Restart reach to apply.`);
  if (cmd === 'link' || cmd === 'rekey') {
    if (!cfg.key) throw new Error('No key yet. Run "reach" first.');
    if (cmd === 'rekey') console.log('New key saved. Restart reach here and run "reach join" with the new key on every other machine.');
    return printAccess(cfg, flags.noQr);
  }
  throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
