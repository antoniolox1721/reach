// Shared by the programs (Node) and the dashboard page (browser): crypto, framing, relay link, controller.
//
// Roles. The dashboard owns a P-256 key pair. Its private half (the "secret") never leaves dashboard
// devices. Clients are given only the public half. Each client makes its own key pair, and all traffic
// with that client is encrypted with a key derived by ECDH between the two. Sending commands therefore
// requires the dashboard secret: a client program cannot control other machines.

export const DEFAULT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
export const CHUNK = 48 * 1024;
const WINDOW = 6;
const EC = { name: 'ECDH', namedCurve: 'P-256' };

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
const sha256hex = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const err = (message, code) => Object.assign(new Error(message), { code });

// ---------- identities ----------

// A secret is d || x || y of a P-256 key (96 bytes); the matching public address is 0x04 || x || y (65 bytes).
export async function newSecret() {
  const pair = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const out = new Uint8Array(96);
  out.set(b64u.dec(jwk.d), 0);
  out.set(b64u.dec(jwk.x), 32);
  out.set(b64u.dec(jwk.y), 64);
  return b64u.enc(out);
}

export function checkSecret(secret) {
  if (!/^[A-Za-z0-9_-]{128}$/.test(String(secret))) throw new Error('That is not a valid dashboard key.');
  return secret;
}

export function checkPublic(pub) {
  if (!/^[A-Za-z0-9_-]{87}$/.test(String(pub)) || b64u.dec(pub)[0] !== 4) throw new Error('That is not a valid dashboard address.');
  return pub;
}

export function publicOf(secret) {
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(b64u.dec(checkSecret(secret)).subarray(32), 1);
  return b64u.enc(raw);
}

// A relay address ends up in links and in files people download, so only plain ws(s) URLs are accepted.
export function checkBroker(broker) {
  if (!broker) return '';
  let ok = /^wss?:\/\/[A-Za-z0-9._~:@%/\[\]+-]+$/.test(broker);
  try {
    new URL(broker);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('The relay address must be a plain ws:// or wss:// URL.');
  return broker;
}

// Reads "#k=<secret>&b=<relay>" (dashboard link), "#p=<public>&b=<relay>" (client), or a bare secret.
export function parseLink(input) {
  const s = String(input || '').trim();
  const i = s.indexOf('#');
  const p = new URLSearchParams(i >= 0 ? s.slice(i + 1) : s.includes('=') ? s : 'k=' + s);
  const out = { broker: checkBroker(p.get('b') || '') };
  if (p.get('k')) out.secret = checkSecret(p.get('k'));
  else if (p.get('p')) out.pub = checkPublic(p.get('p'));
  else throw new Error('That is not a valid dashboard key.');
  return out;
}

export const fleetBase = async (pub) => 'reach2/' + (await sha256hex(b64u.dec(checkPublic(pub)))).slice(0, 32);
export const agentIdOf = async (pubRaw) => (await sha256hex(pubRaw)).slice(0, 24);

function importPrivate(secret) {
  const b = b64u.dec(checkSecret(secret));
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u.enc(b.subarray(0, 32)), x: b64u.enc(b.subarray(32, 64)), y: b64u.enc(b.subarray(64)) };
  return crypto.subtle.importKey('jwk', jwk, EC, false, ['deriveBits']);
}

// The AES key shared by one dashboard and one client. Either side derives it from its own secret and the other's public key.
export async function channelKey(secret, peerPubRaw) {
  const peer = await crypto.subtle.importKey('raw', peerPubRaw, EC, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, await importPrivate(secret), 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('reach/channel/v2') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---------- framing ----------

// Wire format: iv(12) || AES-256-GCM( u32 headerLength || header JSON || body ), with the topic as AAD.
export async function seal(key, topic, header, body) {
  const hdr = te.encode(JSON.stringify(header));
  const b = body ? new Uint8Array(body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body) : new Uint8Array(0);
  const plain = new Uint8Array(4 + hdr.length + b.length);
  new DataView(plain.buffer).setUint32(0, hdr.length);
  plain.set(hdr, 4);
  plain.set(b, 4 + hdr.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(topic) }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function unseal(key, topic, payload) {
  try {
    const p = new Uint8Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    if (p.length < 12 + 16 + 4) return null;
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.subarray(0, 12), additionalData: te.encode(topic) }, key, p.subarray(12)));
    const n = new DataView(plain.buffer).getUint32(0);
    if (n > plain.length - 4) return null;
    return { h: JSON.parse(td.decode(plain.subarray(4, 4 + n))), body: plain.subarray(4 + n) };
  } catch {
    return null;
  }
}

// ---------- relay link ----------

// One connection to the relay. Messages are published and handed to route() strictly in order.
export class Link {
  // will: { topic, payload } prepared by the caller. route(topic, payload) may be async.
  static open({ mqttConnect, broker, subscribe, will, onStatus, route }) {
    const link = new Link();
    link.tx = Promise.resolve();
    link.rx = Promise.resolve();
    link.unacked = 0;
    let ready;
    // Resolves once the relay has confirmed the subscriptions, so replies cannot be missed.
    link.ready = new Promise((r) => (ready = r));
    const opts = { clientId: 'reach_' + randId(8), clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 15000 };
    if (will) opts.will = { ...will, qos: 1, retain: false };
    const client = (link.client = mqttConnect(broker || DEFAULT_BROKER, opts));
    client.on('connect', () => {
      client.subscribe(subscribe, { qos: 1 }, () => {
        ready();
        onStatus?.('online');
      });
    });
    client.on('close', () => onStatus?.('offline'));
    client.on('error', () => {});
    client.on('message', (topic, payload) => {
      link.rx = link.rx.then(() => route(topic, payload)).catch(() => {});
    });
    return link;
  }

  get connected() {
    return this.client.connected;
  }

  // make: async () => Uint8Array
  publish(topic, make, qos = 1) {
    const p = this.tx.then(async () => {
      const payload = await make();
      this.unacked++;
      return new Promise((resolve, reject) => {
        this.client.publish(topic, payload, { qos }, (e) => {
          this.unacked--;
          e ? reject(e) : resolve();
        });
      });
    });
    this.tx = p.catch(() => {});
    return p;
  }

  send(key, topic, header, body, qos = 1) {
    return this.publish(topic, () => seal(key, topic, header, body), qos);
  }

  close() {
    this.client.end(true);
  }
}

// ---------- pairing: tell a new client which dashboard it belongs to, using a one-time code on its screen ----------

const PAIR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newPairCode() {
  const c = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => PAIR_ALPHABET[b & 31]).join('');
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
}

export function normalizePairCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!/^[2-9A-HJ-NP-Z]{12}$/.test(c)) throw new Error('That is not a valid pairing code. It looks like XXXX-XXXX-XXXX.');
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
}

// The code (60 random bits) is stretched, so only someone who saw it can make the client accept a dashboard.
async function pairKeys(code) {
  const base = await crypto.subtle.importKey('raw', te.encode(normalizePairCode(code)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('reach/pair/v2'), iterations: 300000 }, base, 384));
  const enc = await crypto.subtle.importKey('raw', bits.subarray(16), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { enc, base: 'reach2p/' + hex(bits.subarray(0, 16)) };
}

// Client: waits until a dashboard that knows the code introduces itself. Returns { promise -> { pub, broker }, cancel }.
export function pairWait({ mqttConnect, broker, code, name }) {
  let link;
  let cancelled = false;
  const promise = (async () => {
    const keys = await pairKeys(code);
    const offer = await new Promise((resolve) => {
      link = Link.open({
        mqttConnect,
        broker,
        subscribe: [keys.base + '/offer'],
        route: async (topic, payload) => {
          const m = await unseal(keys.enc, topic, payload);
          try {
            if (m) resolve({ pub: checkPublic(m.h.p), broker: checkBroker(m.h.b || '') });
          } catch {}
        },
      });
      if (cancelled) link.close();
    });
    await link.send(keys.enc, keys.base + '/ack', { y: 'ack', name }).catch(() => {});
    link.close();
    return offer;
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      link?.close();
    },
  };
}

// Dashboard: introduces itself to the client showing this code. Resolves with the client's name.
export async function pairOffer({ mqttConnect, broker, code, pub, timeout = 45000 }) {
  const keys = await pairKeys(code);
  let timer;
  let retry;
  let link;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(err('No machine answered for that code. Check the code and that the machine is still waiting.', 'TIMEOUT')), timeout);
      link = Link.open({
        mqttConnect,
        broker,
        subscribe: [keys.base + '/ack'],
        route: async (topic, payload) => {
          const m = await unseal(keys.enc, topic, payload);
          if (m) resolve(String(m.h.name || 'machine'));
        },
      });
      const offer = () => link.ready.then(() => link.send(keys.enc, keys.base + '/offer', { y: 'offer', p: pub, b: broker || '' })).catch(() => {});
      retry = setInterval(offer, 2500);
      offer();
    });
  } finally {
    clearTimeout(timer);
    clearInterval(retry);
    link?.close();
  }
}

// ---------- controller (dashboard side) ----------

// Topics under base = reach2/<hash of dashboard public key>:
//   who                 anyone -> clients: "announce yourselves" (empty, harmless)
//   hello/<aid>         client -> dashboard: client public key (65 bytes) || sealed presence
//   <aid>/to            dashboard -> client: sealed requests
//   <aid>/re/<ctl>      client -> one dashboard session: sealed replies
//   <aid>/out           client -> dashboards: sealed job output
export class Controller {
  constructor({ mqttConnect, broker, secret, onMachines, onStatus }) {
    Object.assign(this, { mqttConnect, broker, secret, onMachines, onStatus });
    this.id = 'c' + randId(8);
    this.machines = new Map();
    this.keys = new Map();
    this.sessions = new Map();
    this.hellos = new Map();
    this.pending = new Map();
    this.jobWatchers = new Map();
  }

  async start() {
    this.pub = publicOf(this.secret);
    const base = (this.base = await fleetBase(this.pub));
    this.link = Link.open({
      mqttConnect: this.mqttConnect,
      broker: this.broker,
      subscribe: [`${base}/hello/+`, `${base}/+/re/${this.id}`, `${base}/+/out`],
      route: (topic, payload) => this._route(topic, payload),
      onStatus: (s) => {
        if (s === 'online') this.link.publish(`${base}/who`, async () => new Uint8Array(0), 0).catch(() => {});
        this.onStatus?.(s);
      },
    });
    this.sweep = setInterval(() => this._sweep(), 5000);
  }

  stop() {
    clearInterval(this.sweep);
    this.link?.close();
  }

  async _route(topic, payload) {
    const parts = topic.slice(this.base.length + 1).split('/');
    if (parts[0] === 'hello') {
      const aid = parts[1];
      if (payload.length < 65) return;
      const pubRaw = new Uint8Array(payload.subarray(0, 65));
      let key = this.keys.get(aid);
      if (!key) {
        // The id is the hash of the client's public key, so a client cannot claim another client's id.
        if ((await agentIdOf(pubRaw)) !== aid) return;
        try {
          key = await channelKey(this.secret, pubRaw);
        } catch {
          return;
        }
        this.keys.set(aid, key);
      }
      const m = await unseal(key, topic, payload.subarray(65));
      if (m) this._presence(aid, m.h);
      return;
    }
    const aid = parts[0];
    const key = this.keys.get(aid);
    if (!key) return;
    const m = await unseal(key, topic, payload);
    if (!m) return;
    if (parts[1] === 're') this._inbox(aid, m.h, m.body);
    else if (parts[1] === 'out') for (const fn of this.jobWatchers.get(aid + '/' + m.h.job) || []) fn(m.h, m.body);
  }

  _presence(aid, h) {
    if (Math.abs(Date.now() - h.ts) > 10 * 60 * 1000) return;
    if (h.y === 'bye') {
      const m = this.machines.get(aid);
      if (m && m.boot === h.boot) m.seen = 0;
    } else if (h.y === 'pres') {
      const prev = this.machines.get(aid);
      if (prev && prev.boot !== h.boot) this.sessions.delete(aid);
      this.machines.set(aid, { id: aid, name: String(h.name), os: String(h.os), host: String(h.host), boot: h.boot, seen: Date.now() });
    }
    this._sweep();
  }

  _sweep() {
    const list = [...this.machines.values()].map((m) => ({ ...m, online: Date.now() - m.seen < 50000 }));
    list.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    this.onMachines?.(list);
  }

  _inbox(aid, h, body) {
    if (h.y === 'welcome') {
      const w = this.hellos.get(h.c);
      if (w && w.agent === aid) w.resolve(h);
      return;
    }
    const p = this.pending.get(h.id);
    if (!p || p.agent !== aid) return;
    if (h.y === 'nosession') {
      this.sessions.delete(aid);
      p.reject(err('session expired', 'NOSESSION'));
    } else if (h.y === 'res') {
      h.ok ? p.resolve({ r: h.r, body }) : p.reject(err(h.e || 'failed', 'REMOTE'));
    } else if (h.y === 'ev') {
      p.onEv?.(h, body);
    }
  }

  _send(agent, header, body) {
    const key = this.keys.get(agent);
    if (!key) return Promise.reject(err('That machine is not known yet.', 'UNKNOWN'));
    return this.link.send(key, `${this.base}/${agent}/to`, header, body);
  }

  async _session(agent) {
    let s = this.sessions.get(agent);
    if (s) return s;
    const c = randId(12);
    const welcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(err('The machine did not answer. Is reach still running on it?', 'TIMEOUT')), 10000);
      this.hellos.set(c, { agent, resolve: (h) => (clearTimeout(timer), resolve(h)) });
      this._send(agent, { y: 'hello', f: this.id, c }).catch(reject);
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
          this._send(agent, { y: 'req', f: this.id, s: sess.s, n: ++sess.n, id, op, a }, body).catch(reject);
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
