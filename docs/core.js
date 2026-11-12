// Shared by the agent (Node) and the dashboard (browser): crypto, framing, relay link, controller.

export const DEFAULT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
export const CHUNK = 48 * 1024;
const WINDOW = 6;

const te = new TextEncoder();
const td = new TextDecoder();

export const b64u = {
  enc(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const randId = (n = 8) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const newKey = () => b64u.enc(crypto.getRandomValues(new Uint8Array(32)));

// Accepts a bare key or a dashboard link containing #k=<key>[&b=<broker>].
export function parseKeyInput(input) {
  const s = String(input || '').trim();
  const i = s.indexOf('#');
  if (i >= 0 || s.includes('k=')) {
    const p = new URLSearchParams(i >= 0 ? s.slice(i + 1) : s);
    return { key: p.get('k') || '', broker: p.get('b') || '' };
  }
  return { key: s, broker: '' };
}

export async function deriveKeys(keyStr) {
  let raw;
  try {
    raw = b64u.dec(keyStr);
  } catch {
    raw = new Uint8Array(0);
  }
  if (raw.length !== 32) throw new Error('That is not a valid reach key.');
  const hk = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) });
  const enc = await crypto.subtle.deriveKey(params('reach/enc/v1'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tid = new Uint8Array(await crypto.subtle.deriveBits(params('reach/topic/v1'), hk, 128));
  return { enc, base: 'reach1/' + hex(tid) };
}

// Wire format: iv(12) || AES-256-GCM( u32 headerLength || header JSON || body ), with the topic as AAD.
async function seal(keys, topic, header, body) {
  const hdr = te.encode(JSON.stringify(header));
  const b = body ? new Uint8Array(body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body) : new Uint8Array(0);
  const plain = new Uint8Array(4 + hdr.length + b.length);
  new DataView(plain.buffer).setUint32(0, hdr.length);
  plain.set(hdr, 4);
  plain.set(b, 4 + hdr.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(topic) }, keys.enc, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function unseal(keys, topic, payload) {
  try {
    const p = new Uint8Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    if (p.length < 12 + 16 + 4) return null;
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.subarray(0, 12), additionalData: te.encode(topic) }, keys.enc, p.subarray(12)));
    const n = new DataView(plain.buffer).getUint32(0);
    if (n > plain.length - 4) return null;
    return { h: JSON.parse(td.decode(plain.subarray(4, 4 + n))), body: plain.subarray(4 + n) };
  } catch {
    return null;
  }
}

// One encrypted connection to the relay. Messages are sent and delivered strictly in order.
export class Link {
  static async open({ mqttConnect, broker, keys, subscribe, will, onStatus }) {
    const link = new Link();
    link.keys = keys;
    link.handlers = [];
    link.tx = Promise.resolve();
    link.rx = Promise.resolve();
    link.unacked = 0;
    const opts = { clientId: 'reach_' + randId(8), clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 15000 };
    if (will) {
      const topic = link.topic(will.suffix);
      opts.will = { topic, payload: await seal(keys, topic, will.header), qos: 1, retain: false };
    }
    const client = (link.client = mqttConnect(broker || DEFAULT_BROKER, opts));
    client.on('connect', () => {
      client.subscribe(subscribe.map((s) => link.topic(s)), { qos: 1 }, () => onStatus?.('online'));
    });
    client.on('close', () => onStatus?.('offline'));
    client.on('error', () => {});
    client.on('message', (topic, payload) => {
      link.rx = link.rx.then(async () => {
        const m = await unseal(keys, topic, payload);
        if (!m) return;
        const suffix = topic.slice(keys.base.length + 1);
        for (const [match, fn] of link.handlers) {
          if (match === suffix || (match.endsWith('/') && suffix.startsWith(match))) {
            try {
              fn(m.h, m.body, suffix);
            } catch {}
          }
        }
      });
    });
    return link;
  }

  get connected() {
    return this.client.connected;
  }

  topic(suffix) {
    return this.keys.base + '/' + suffix;
  }

  // match: exact suffix, or a prefix ending in "/".
  on(match, fn) {
    this.handlers.push([match, fn]);
  }

  send(suffix, header, body, qos = 1) {
    const topic = this.topic(suffix);
    const p = this.tx.then(async () => {
      const payload = await seal(this.keys, topic, header, body);
      this.unacked++;
      return new Promise((resolve, reject) => {
        this.client.publish(topic, payload, { qos }, (err) => {
          this.unacked--;
          err ? reject(err) : resolve();
        });
      });
    });
    this.tx = p.catch(() => {});
    return p;
  }

  close() {
    this.client.end(true);
  }
}

const err = (message, code) => Object.assign(new Error(message), { code });

// Talks to agents: discovery, request/response, file transfer, job output.
export class Controller {
  constructor({ mqttConnect, broker, key, onMachines, onStatus }) {
    Object.assign(this, { mqttConnect, broker, key, onMachines, onStatus });
    this.id = 'c' + randId(8);
    this.machines = new Map();
    this.sessions = new Map();
    this.hellos = new Map();
    this.pending = new Map();
    this.jobWatchers = new Map();
  }

  async start() {
    const keys = await deriveKeys(this.key);
    this.link = await Link.open({
      mqttConnect: this.mqttConnect,
      broker: this.broker,
      keys,
      subscribe: ['pres', 'to/' + this.id, 'out/+'],
      onStatus: (s) => {
        if (s === 'online') this.link?.send('who', { y: 'who', f: this.id }, null, 0).catch(() => {});
        this.onStatus?.(s);
      },
    });
    this.link.on('pres', (h) => this._presence(h));
    this.link.on('to/' + this.id, (h, body) => this._inbox(h, body));
    this.link.on('out/', (h, body, suffix) => this._out(suffix.slice(4), h, body));
    this.sweep = setInterval(() => this._sweep(), 5000);
  }

  stop() {
    clearInterval(this.sweep);
    this.link?.close();
  }

  _presence(h) {
    if (typeof h.id !== 'string' || Math.abs(Date.now() - h.ts) > 10 * 60 * 1000) return;
    if (h.y === 'bye') {
      const m = this.machines.get(h.id);
      if (m && m.boot === h.boot) m.seen = 0;
    } else if (h.y === 'pres') {
      const prev = this.machines.get(h.id);
      if (prev && prev.boot !== h.boot) this.sessions.delete(h.id);
      this.machines.set(h.id, { id: h.id, name: String(h.name), os: String(h.os), host: String(h.host), boot: h.boot, seen: Date.now() });
    }
    this._sweep();
  }

  _sweep() {
    const list = [...this.machines.values()].map((m) => ({ ...m, online: Date.now() - m.seen < 50000 }));
    list.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    this.onMachines?.(list);
  }

  _inbox(h, body) {
    if (h.y === 'welcome') {
      const w = this.hellos.get(h.c);
      if (w && w.agent === h.f) w.resolve(h);
      return;
    }
    const p = this.pending.get(h.id);
    if (!p || p.agent !== h.f) return;
    if (h.y === 'nosession') {
      this.sessions.delete(p.agent);
      p.reject(err('session expired', 'NOSESSION'));
    } else if (h.y === 'res') {
      h.ok ? p.resolve({ r: h.r, body }) : p.reject(err(h.e || 'failed', 'REMOTE'));
    } else if (h.y === 'ev') {
      p.onEv?.(h, body);
    }
  }

  _out(agent, h, body) {
    if (h.f !== agent) return;
    for (const fn of this.jobWatchers.get(agent + '/' + h.job) || []) fn(h, body);
  }

  async _session(agent) {
    let s = this.sessions.get(agent);
    if (s) return s;
    const c = randId(12);
    const welcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(err('The machine did not answer. Is reach still running on it?', 'TIMEOUT')), 10000);
      this.hellos.set(c, { agent, resolve: (h) => (clearTimeout(timer), resolve(h)) });
      this.link.send('to/' + agent, { y: 'hello', f: this.id, c }).catch(reject);
    }).finally(() => this.hellos.delete(c));
    s = { s: welcome.s, n: 0, info: welcome.info };
    this.sessions.set(agent, s);
    return s;
  }

  async info(agent) {
    return (await this._session(agent)).info;
  }

  // keep: leave the request registered after the response so stream events keep arriving; caller must call done().
  async call(agent, op, a = {}, body = null, { timeout = 20000, onEv, keep = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const sess = await this._session(agent);
      const id = randId(8);
      let timer;
      const done = () => this.pending.delete(id);
      try {
        const res = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(err('The machine did not answer in time.', 'TIMEOUT')), timeout);
          this.pending.set(id, { agent, resolve, reject, onEv });
          this.link.send('to/' + agent, { y: 'req', f: this.id, s: sess.s, n: ++sess.n, id, op, a }, body).catch(reject);
        });
        if (!keep) done();
        return { ...res, id, done };
      } catch (e) {
        done();
        if (e.code === 'NOSESSION' && attempt === 0) continue;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // Streams a remote file to onChunk(Uint8Array). Resolves with { size, mtime }.
  async download(agent, path, { onChunk, onProgress, signal } = {}) {
    let expect = 0;
    let got = 0;
    let size = 0;
    let finish, fail, idle;
    const finished = new Promise((a, b) => ((finish = a), (fail = b)));
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(err('The transfer stalled.', 'TIMEOUT')), 30000);
    };
    let id;
    const onEv = (h, body) => {
      if (h.seq < expect) return;
      if (h.seq > expect) return fail(err('The transfer lost data.', 'ORDER'));
      expect++;
      got += body.length;
      arm();
      try {
        onChunk?.(body);
      } catch (e) {
        return fail(e);
      }
      onProgress?.(got, size);
      if (h.last) return finish();
      if (expect % 4 === 0) this.call(agent, 'ack', { x: id, seq: h.seq }).catch(() => {});
    };
    const res = await this.call(agent, 'read', { path }, null, { onEv, keep: true });
    id = res.id;
    size = res.r.size;
    arm();
    const abort = () => fail(err('Cancelled.', 'ABORT'));
    signal?.addEventListener('abort', abort);
    try {
      await finished;
      return res.r;
    } catch (e) {
      this.call(agent, 'cancel', { x: id }).catch(() => {});
      throw e;
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
      res.done();
    }
  }

  // src: { size, read(offset, length) -> Promise<Uint8Array> }
  async upload(agent, path, src, { onProgress, signal } = {}) {
    const { r } = await this.call(agent, 'wopen', { path, size: src.size });
    const inflight = new Set();
    let sent = 0;
    try {
      for (let off = 0, seq = 0; off < src.size; seq++) {
        if (signal?.aborted) throw err('Cancelled.', 'ABORT');
        const buf = await src.read(off, CHUNK);
        if (!buf.length) throw err('The file changed while uploading.', 'SHORT');
        off += buf.length;
        const p = this.call(agent, 'wchunk', { x: r.x, seq }, buf, { timeout: 60000 }).then(() => {
          sent += buf.length;
          onProgress?.(sent, src.size);
        });
        inflight.add(p);
        p.catch(() => {}).finally(() => inflight.delete(p));
        if (inflight.size >= WINDOW) await Promise.race(inflight);
      }
      await Promise.all(inflight);
      await this.call(agent, 'wclose', { x: r.x }, null, { timeout: 60000 });
    } catch (e) {
      this.call(agent, 'wabort', { x: r.x }).catch(() => {});
      throw e;
    }
  }

  // fn(header, body) for { y: 'out', job, off } and { y: 'exit', job, code, end }. Returns an unsubscribe function.
  watchJob(agent, job, fn) {
    const k = agent + '/' + job;
    if (!this.jobWatchers.has(k)) this.jobWatchers.set(k, new Set());
    this.jobWatchers.get(k).add(fn);
    return () => this.jobWatchers.get(k)?.delete(fn);
  }
}
