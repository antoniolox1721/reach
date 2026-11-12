import { Controller, parseKeyInput, deriveKeys, pairOffer, normalizePairCode, b64u } from './core.js';

const VAULT = 'reach.vault';
const PBKDF2_ITERATIONS = 600000;
const MAX_OPEN = 2 * 1024 * 1024;
const MAX_TERM = 300000;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

const te = new TextEncoder();
const $ = (s) => document.querySelector(s);
const view = $('#view');

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, String(msg));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}
const fail = (e) => toast(e?.message || e, true);

const fmtSize = (n) => {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
};
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '');

// ---------- password vault: the key is stored only encrypted with the device password ----------

async function passwordKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function saveVault(password, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await passwordKey(password, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(secret))));
  localStorage.setItem(VAULT, JSON.stringify({ v: 1, iter: PBKDF2_ITERATIONS, salt: b64u.enc(salt), iv: b64u.enc(iv), ct: b64u.enc(ct) }));
}

async function openVault(password) {
  const v = JSON.parse(localStorage.getItem(VAULT));
  const k = await passwordKey(password, b64u.dec(v.salt), v.iter);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(v.iv) }, k, b64u.dec(v.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Wrong password.');
  }
}

// ---------- app state ----------

let ctl = null;
let secret = null;
let machines = [];
let current = null; // { id, name, info, tab, files, term }
let screen = 'boot';
let pendingPair = null; // pairing code that arrived in the link, handled after unlock

function setHeader(title, back) {
  $('#title').textContent = title;
  $('#back').hidden = !back;
  $('#lock').hidden = !ctl;
}

function setStatus(s) {
  $('#status').className = 'dot ' + (s === 'online' ? 'on' : s === 'offline' ? 'off' : '');
}

$('#back').addEventListener('click', () => history.back());
$('#lock').addEventListener('click', lock);
window.addEventListener('popstate', () => {
  if (current) closeMachine();
});

function lock() {
  ctl?.stop();
  ctl = null;
  secret = null;
  current = null;
  machines = [];
  setStatus('');
  showUnlock();
}

// ---------- sign-in screens ----------

function showUnlock() {
  screen = 'unlock';
  setHeader('reach', false);
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const msg = h('p', { class: 'error' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Unlock');
  const form = h(
    'form',
    {
      class: 'pad',
      onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true;
        msg.textContent = '';
        try {
          await connect(await openVault(pw.value));
        } catch (err) {
          msg.textContent = err.message;
          go.disabled = false;
        }
      },
    },
    h('div', { class: 'card' }, h('p', null, 'Enter your password to unlock this device.'), h('label', null, 'Password'), pw, msg, h('div', { class: 'row' }, go)),
    h(
      'button',
      {
        class: 'ghost danger small',
        type: 'button',
        onclick: () => {
          if (!confirm('Remove the saved key from this device? You will need the dashboard link again.')) return;
          localStorage.removeItem(VAULT);
          showSetup('');
        },
      },
      'Forget this device'
    )
  );
  view.replaceChildren(form);
  pw.focus();
}

function showSetup(prefill, broker = '') {
  screen = 'setup';
  setHeader('reach', false);
  const hadVault = !!localStorage.getItem(VAULT);
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Key or dashboard link', value: prefill });
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat the password' });
  const msg = h('p', { class: 'error' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Save and connect');
  const form = h(
    'form',
    {
      class: 'pad',
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = '';
        try {
          const parsed = parseKeyInput(key.value);
          await deriveKeys(parsed.key);
          if (pw1.value.length < 8) throw new Error('Use a password of at least 8 characters.');
          if (pw1.value !== pw2.value) throw new Error('The two passwords do not match.');
          go.disabled = true;
          const s = { key: parsed.key, broker: parsed.broker || broker };
          await saveVault(pw1.value, s);
          await connect(s);
        } catch (err) {
          msg.textContent = err.message;
          go.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'card' },
      prefill
        ? h('p', null, 'Key received from the link. Only continue if this link came from your own machine: the dashboard will control whatever machines use that key. Choose a password for this device. You will type it each time you open this page.')
        : h('p', null, 'Run ', h('code', null, 'reach'), ' on one of your machines, then open the link it prints (or paste the key here).'),
      prefill && hadVault && h('p', { class: 'error' }, 'This device already has a saved key. Continuing replaces it with the key from the link.'),
      broker && h('p', { class: 'small' }, 'This link uses a custom relay: ', h('code', null, broker)),
      h('label', null, 'Key'),
      key,
      h('label', null, 'Password for this device'),
      pw1,
      h('label', null, 'Repeat password'),
      pw2,
      msg,
      h('div', { class: 'row' }, go, prefill && hadVault && h('button', { type: 'button', onclick: showUnlock }, 'Keep my saved key'))
    ),
    h('p', { class: 'dim small' }, 'The key never leaves this device unencrypted: it is stored here locked with your password, and this page has no server.')
  );
  view.replaceChildren(form);
  (prefill ? pw1 : key).focus();
}

async function connect(s) {
  secret = s;
  ctl = new Controller({
    mqttConnect: window.mqtt.connect,
    broker: s.broker || undefined,
    key: s.key,
    onStatus: setStatus,
    onMachines: (list) => {
      machines = list;
      if (screen === 'machines') showMachines();
    },
  });
  await ctl.start();
  showMachines();
  if (pendingPair) {
    const code = pendingPair;
    pendingPair = null;
    addMachine(code);
  }
}

// Sends the key to the machine that is showing this one-time code.
async function addMachine(input) {
  let code;
  try {
    code = normalizePairCode(input);
  } catch (e) {
    return fail(e);
  }
  if (!confirm(`Add the machine showing code ${code}?\n\nOnly continue if you can see this exact code on a machine you just started yourself. That machine gets your key: it joins your dashboard and whoever controls it can reach all your machines.`)) return;
  toast('Looking for the machine…');
  try {
    const name = await pairOffer({ mqttConnect: window.mqtt.connect, broker: secret.broker || undefined, code, secret });
    toast(`Added "${name}". It will appear in the list in a moment.`);
  } catch (e) {
    fail(e);
  }
}

// ---------- machine list ----------

function showMachines() {
  screen = 'machines';
  setHeader('My machines', false);
  const cards = machines.map((m) =>
    h(
      'button',
      { class: 'card machine' + (m.online ? '' : ' offline'), onclick: () => openMachine(m) },
      h('span', { class: 'dot ' + (m.online ? 'on' : 'off') }),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'dim small' }, m.os + (m.host && m.host !== m.name ? ' · ' + m.host : '') + (m.online ? '' : ' · offline')))
    )
  );
  const joinCmd = 'npx github:antoniolox1721/reach join ' + secret.key + (secret.broker ? ' --broker ' + secret.broker : '');
  const keyBox = h('div', { hidden: true }, h('p', { class: 'dim small' }, 'With Node.js installed you can also run this on the new machine. It contains your key, so do not share it.'), h('div', { class: 'cmdbox mono' }, joinCmd));
  const codeInput = h('input', { class: 'mono', placeholder: 'XXXX-XXXX-XXXX', 'aria-label': 'Pairing code', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
  const reveal = h(
    'div',
    { hidden: true },
    h('p', { class: 'small' }, '1. On the new machine, download and start reach: ', h('a', { href: 'https://github.com/antoniolox1721/reach/releases/latest', target: '_blank', rel: 'noopener noreferrer' }, 'get the program'), '.'),
    h('p', { class: 'small' }, '2. It shows a code. Type it here (or scan its QR code with this phone).'),
    h(
      'form',
      {
        class: 'row',
        onsubmit: (e) => {
          e.preventDefault();
          addMachine(codeInput.value);
        },
      },
      codeInput,
      h('button', { class: 'primary', type: 'submit' }, 'Add')
    ),
    h('p', null, h('button', { class: 'ghost small', onclick: () => (keyBox.hidden = !keyBox.hidden) }, 'Use the key instead')),
    keyBox
  );
  view.replaceChildren(
    h(
      'div',
      { class: 'pad' },
      cards.length ? cards : h('div', { class: 'empty' }, 'Looking for your machines… Make sure reach is running on at least one.'),
      h('div', { class: 'card' }, h('button', { class: 'ghost', onclick: () => (reveal.hidden = !reveal.hidden) }, '+ Add a machine'), reveal)
    )
  );
}

async function openMachine(m) {
  try {
    const info = await ctl.info(m.id);
    current = { id: m.id, name: m.name, info, tab: 'files', files: { path: info.home }, term: newTerm(info.home) };
    history.pushState({ machine: m.id }, '');
    showMachine();
  } catch (e) {
    fail(e);
  }
}

function closeMachine() {
  current?.term.unwatch?.();
  current = null;
  showMachines();
}

function showMachine() {
  screen = 'machine';
  setHeader(current.name, true);
  const body = h('div', { class: 'tab' });
  const tabs = ['files', 'terminal', 'scripts'].map((t) =>
    h(
      'button',
      {
        class: current.tab === t ? 'active' : '',
        onclick: () => {
          current.tab = t;
          showMachine();
        },
      },
      t[0].toUpperCase() + t.slice(1)
    )
  );
  view.replaceChildren(h('div', { class: 'tabs' }, tabs), body);
  ({ files: renderFiles, terminal: renderTerminal, scripts: renderScripts })[current.tab](body);
}

const call = (op, a, body, opts) => ctl.call(current.id, op, a, body, opts);
const joinPath = (dir, name) => (dir.endsWith(current.info.sep) ? dir : dir + current.info.sep) + name;

// ---------- files ----------

async function renderFiles(body) {
  const me = current;
  const f = me.files;
  const pathInput = h('input', { class: 'mono', value: f.path, 'aria-label': 'Folder path', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'list' }, h('div', { class: 'empty' }, 'Loading…'));
  const go = (p) => {
    f.path = p;
    if (current === me && me.tab === 'files') showMachine();
  };
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => uploadFiles([...picker.files], f, () => go(f.path)) });
  body.append(
    h(
      'form',
      {
        class: 'bar',
        onsubmit: (e) => {
          e.preventDefault();
          go(pathInput.value);
        },
      },
      pathInput,
      h('button', { type: 'submit' }, 'Go')
    ),
    h(
      'div',
      { class: 'bar' },
      h('button', { onclick: () => f.parent && go(f.parent) }, '↑ Up'),
      h('button', { onclick: () => go(me.info.home) }, 'Home'),
      me.info.roots.map((r) => h('button', { onclick: () => go(r) }, r)),
      h('button', { onclick: () => picker.click() }, 'Upload'),
      h(
        'button',
        {
          onclick: async () => {
            const name = prompt('New folder name');
            if (!name) return;
            await call('mkdir', { path: joinPath(f.path, name) }).catch(fail);
            go(f.path);
          },
        },
        'New folder'
      ),
      picker
    ),
    list
  );
  try {
    const { r } = await call('ls', { path: f.path });
    if (current !== me) return;
    f.path = r.path;
    f.parent = r.parent;
    f.names = new Set(r.entries.map((e) => e.n));
    pathInput.value = r.path;
    r.entries.sort((a, b) => b.d - a.d || a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: 'base' }));
    const rows = r.entries.map((e) =>
      h(
        'div',
        { class: 'entry' + (e.d ? ' dir' : ''), onclick: () => (e.d ? go(joinPath(r.path, e.n)) : fileSheet(e, r.path, go)) },
        h('span', { class: 'glyph' }, e.d ? '▸' : '·'),
        h('span', { class: 'grow' }, h('div', { class: 'n' }, e.n), h('div', { class: 'meta' }, (e.d ? 'folder' : fmtSize(e.s)) + (e.m ? ' · ' + fmtDate(e.m) : ''))),
        h(
          'button',
          {
            class: 'icon',
            'aria-label': 'Actions for ' + e.n,
            onclick: (ev) => {
              ev.stopPropagation();
              fileSheet(e, r.path, go);
            },
          },
          '⋯'
        )
      )
    );
    if (r.truncated) rows.push(h('div', { class: 'empty' }, 'Only the first 5000 entries are shown.'));
    list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, 'This folder is empty.')]));
  } catch (e) {
    list.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
}

function sheet(title, actions) {
  const close = () => overlay.remove();
  const overlay = h(
    'div',
    { class: 'overlay', onclick: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'sheet' },
      h('h2', null, title),
      actions.filter(Boolean).map(([label, fn, cls]) =>
        h(
          'button',
          {
            class: cls || '',
            onclick: () => {
              close();
              Promise.resolve(fn()).catch(fail);
            },
          },
          label
        )
      ),
      h('button', { class: 'ghost', onclick: close }, 'Cancel')
    )
  );
  document.body.append(overlay);
}

function fileSheet(e, dir, go) {
  const full = joinPath(dir, e.n);
  const refresh = () => go(dir);
  sheet(e.n, [
    !e.d && ['Open', () => openFile(e, full, refresh)],
    !e.d && ['Download to this device', () => downloadFile(e, full)],
    e.d && [
      'Open terminal here',
      () => {
        current.term.cwd = full;
        current.tab = 'terminal';
        showMachine();
      },
    ],
    [
      'Rename',
      async () => {
        const name = prompt('New name', e.n);
        if (!name || name === e.n) return;
        await call('mv', { from: full, to: joinPath(dir, name) });
        refresh();
      },
    ],
    [
      'Delete',
      async () => {
        if (!confirm(`Delete "${e.n}"${e.d ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
        await call('rm', { path: full }, null, { timeout: 120000 });
        refresh();
      },
      'danger',
    ],
  ]);
}

function transfer(label) {
  const fill = h('div', { class: 'fill' });
  const text = h('span', { class: 'grow small' }, label);
  const ac = new AbortController();
  const el = h('div', { class: 'xfer' }, h('div', { class: 'row' }, text, h('button', { class: 'ghost small', onclick: () => ac.abort() }, 'Cancel')), h('div', { class: 'track' }, fill));
  $('#transfers').append(el);
  return {
    signal: ac.signal,
    progress: (done, total) => {
      fill.style.width = (total ? (done / total) * 100 : 100) + '%';
      text.textContent = `${label} · ${fmtSize(done)} / ${fmtSize(total)}`;
    },
    end: () => el.remove(),
  };
}

async function fetchFile(agent, e, full) {
  const t = transfer('↓ ' + e.n);
  const parts = [];
  try {
    await ctl.download(agent, full, { onChunk: (c) => parts.push(c.slice()), onProgress: t.progress, signal: t.signal });
    return parts;
  } finally {
    t.end();
  }
}

async function downloadFile(e, full) {
  if (e.s > 500 * 1024 * 1024 && !confirm(`${e.n} is ${fmtSize(e.s)}. The browser holds the whole file in memory while downloading. Continue?`)) return;
  const parts = await fetchFile(current.id, e, full);
  const url = URL.createObjectURL(new Blob(parts));
  const a = h('a', { href: url, download: e.n });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function openFile(e, full, refresh) {
  if (e.s > MAX_OPEN) return toast(`${e.n} is too large to open here (${fmtSize(e.s)}). Download it instead.`, true);
  const agent = current.id;
  const parts = await fetchFile(agent, e, full);
  const blob = new Blob(parts);
  let content;
  if (IMAGE.test(e.n)) {
    const url = URL.createObjectURL(blob);
    content = h('div', { class: 'imgwrap' }, h('img', { src: url, alt: e.n }));
  } else {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    } catch {
      return toast(`${e.n} is not a text file. Download it instead.`, true);
    }
    content = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    content.value = text;
  }
  const close = () => full_.remove();
  const save = h(
    'button',
    {
      class: 'primary',
      hidden: content.tagName !== 'TEXTAREA',
      onclick: async () => {
        save.disabled = true;
        try {
          const data = te.encode(content.value);
          await ctl.upload(agent, full, { size: data.length, read: async (off, len) => data.subarray(off, off + len) });
          toast('Saved ' + e.n);
          refresh();
        } catch (err) {
          fail(err);
        }
        save.disabled = false;
      },
    },
    'Save'
  );
  const full_ = h('div', { class: 'full' }, h('header', null, h('h1', null, e.n), save, h('button', { onclick: close }, 'Close')), content);
  document.body.append(full_);
}

async function uploadFiles(files, f, refresh) {
  const agent = current.id;
  for (const file of files) {
    if (f.names?.has(file.name) && !confirm(`"${file.name}" already exists here. Replace it?`)) continue;
    const t = transfer('↑ ' + file.name);
    try {
      await ctl.upload(agent, joinPath(f.path, file.name), { size: file.size, read: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()) }, { onProgress: t.progress, signal: t.signal });
      toast('Uploaded ' + file.name);
    } catch (e) {
      fail(e);
    } finally {
      t.end();
    }
  }
  refresh();
}

// ---------- terminal ----------

function newTerm(cwd) {
  return { cwd, log: h('pre', { class: 'term' }), job: null, unwatch: null, next: 0, decoder: null, chars: 0, history: [], hpos: 0, onchange: null };
}

function termWrite(t, text, cls) {
  if (!text) return;
  const stick = t.log.scrollHeight - t.log.scrollTop - t.log.clientHeight < 60;
  t.log.append(cls ? h('span', { class: cls }, text) : document.createTextNode(text));
  t.chars += text.length;
  while (t.chars > MAX_TERM && t.log.firstChild) {
    t.chars -= t.log.firstChild.textContent.length;
    t.log.firstChild.remove();
  }
  if (stick) t.log.scrollTop = t.log.scrollHeight;
}

const cleanOutput = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r/g, '');

// Follows a job's output. Offsets make it safe to combine the live stream with a catch-up 'tail'.
async function attach(t, agent, job, from) {
  t.unwatch?.();
  t.job = job;
  t.next = from;
  t.decoder = new TextDecoder();
  let exited = false;
  const feed = (off, body) => {
    if (off > t.next) {
      termWrite(t, '\n[… some output skipped …]\n', 'note');
      t.next = off;
    }
    const skip = t.next - off;
    if (skip >= body.length) return;
    t.next = off + body.length;
    termWrite(t, cleanOutput(t.decoder.decode(body.subarray(skip), { stream: true })));
  };
  const exit = (code) => {
    if (exited) return;
    exited = true;
    termWrite(t, `\n[finished, exit code ${code}]\n`, 'note');
    if (t.job === job) {
      t.job = null;
      t.unwatch?.();
      t.unwatch = null;
    }
    t.onchange?.();
  };
  t.unwatch = ctl.watchJob(agent, job, (hd, body) => (hd.y === 'out' ? feed(hd.off, body) : exit(hd.code)));
  t.onchange?.();
  try {
    const { r, body } = await ctl.call(agent, 'tail', { job });
    if (from === null) t.next = r.from;
    feed(Math.max(r.from, t.next), body.subarray(Math.max(0, t.next - r.from)));
    if (!r.running) exit(r.code);
  } catch (e) {
    fail(e);
  }
}

async function runCommand(t, cmd) {
  const agent = current.id;
  cmd = cmd.trim();
  if (!cmd) return;
  if (t.history[t.history.length - 1] !== cmd) t.history.push(cmd);
  t.hpos = t.history.length;
  termWrite(t, `\n${t.cwd} $ ${cmd}\n`, 'prompt');
  t.log.scrollTop = t.log.scrollHeight;
  const cd = /^cd(?:\s+(.*))?$/.exec(cmd);
  try {
    if (cmd === 'clear' || cmd === 'cls') {
      t.log.replaceChildren();
      t.chars = 0;
    } else if (cd) {
      const target = (cd[1] || '~').replace(/^(["'])(.*)\1$/, '$2');
      t.cwd = (await ctl.call(agent, 'resolve', { cwd: t.cwd, path: target })).r.path;
      t.onchange?.();
    } else {
      const { r } = await ctl.call(agent, 'exec', { cmd, cwd: t.cwd });
      await attach(t, agent, r.job, 0);
    }
  } catch (e) {
    termWrite(t, e.message + '\n', 'note');
  }
}

function renderTerminal(body) {
  const me = current;
  const t = me.term;
  const chips = h('div', { class: 'bar' });
  const cwd = h('div', { class: 'cwd' });
  const input = h('input', { 'aria-label': 'Command', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send' });
  const send = h('button', { class: 'primary', type: 'submit' });
  const stop = h('button', { class: 'danger', type: 'button', onclick: () => t.job && call('kill', { job: t.job }).catch(fail) }, 'Stop');
  const recall = (d) => {
    if (!t.history.length) return;
    t.hpos = Math.max(0, Math.min(t.history.length, t.hpos + d));
    input.value = t.history[t.hpos] || '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      recall(e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  const loadJobs = async () => {
    try {
      const { r } = await call('jobs');
      if (current !== me) return;
      const items = r
        .slice(-8)
        .reverse()
        .map((j) =>
          h(
            'button',
            {
              class: 'chip' + (j.running ? ' running' : ''),
              title: j.cmd,
              onclick: () => {
                t.log.replaceChildren();
                t.chars = 0;
                termWrite(t, `${j.cwd} $ ${j.cmd}\n`, 'prompt');
                attach(t, me.id, j.job, null);
              },
            },
            (j.running ? '● ' : '') + j.cmd
          )
        );
      chips.replaceChildren(h('span', { class: 'dim small' }, 'Jobs'), ...(items.length ? items : [h('span', { class: 'dim small' }, 'none yet')]));
    } catch {}
  };
  t.onchange = () => {
    cwd.textContent = t.job ? 'Running. Type to send input to the program.' : t.cwd;
    send.textContent = t.job ? 'Send' : 'Run';
    stop.hidden = !t.job;
    input.placeholder = t.job ? 'input for the running program' : 'command';
    if (current === me && me.tab === 'terminal') loadJobs();
  };

  body.append(
    chips,
    t.log,
    cwd,
    h(
      'form',
      {
        class: 'inputrow',
        onsubmit: (e) => {
          e.preventDefault();
          const v = input.value;
          input.value = '';
          if (t.job) {
            termWrite(t, v + '\n', 'prompt');
            call('stdin', { job: t.job }, te.encode(v + '\n')).catch(fail);
          } else {
            runCommand(t, v);
          }
        },
      },
      h('button', { type: 'button', 'aria-label': 'Previous command', onclick: () => recall(-1) }, '↑'),
      input,
      stop,
      send
    )
  );
  t.onchange();
  t.log.scrollTop = t.log.scrollHeight;
}

// ---------- scripts ----------

async function renderScripts(body) {
  const me = current;
  const wrap = h('div', { class: 'pad' }, h('div', { class: 'empty' }, 'Loading…'));
  body.append(h('div', { class: 'list' }, wrap));
  let scripts;
  try {
    scripts = (await call('scripts.get')).r;
  } catch (e) {
    return wrap.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
  if (current !== me) return;
  const save = async () => {
    await call('scripts.set', { scripts }).catch(fail);
    draw();
  };
  const edit = (i) => {
    const s = scripts[i] || { name: '', cmd: '', cwd: me.files.path };
    const name = h('input', { value: s.name, placeholder: 'e.g. Render video' });
    const cmd = h('textarea', { rows: '3', class: 'mono', spellcheck: 'false', autocapitalize: 'off', placeholder: 'e.g. python render.py --quality high' });
    cmd.value = s.cmd;
    const cwd = h('input', { class: 'mono', value: s.cwd, autocapitalize: 'off', spellcheck: 'false' });
    wrap.replaceChildren(
      h(
        'form',
        {
          class: 'card',
          onsubmit: (e) => {
            e.preventDefault();
            if (!name.value.trim() || !cmd.value.trim()) return toast('Give the script a name and a command.', true);
            const item = { name: name.value.trim(), cmd: cmd.value, cwd: cwd.value.trim() };
            if (i < scripts.length) scripts[i] = item;
            else scripts.push(item);
            save();
          },
        },
        h('label', null, 'Name'),
        name,
        h('label', null, 'Command'),
        cmd,
        h('label', null, 'Run in folder'),
        cwd,
        h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: draw }, 'Cancel'))
      )
    );
    name.focus();
  };
  const draw = () => {
    wrap.replaceChildren(
      ...scripts.map((s, i) =>
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'name' }, s.name),
          h('div', { class: 'mono dim' }, s.cmd),
          s.cwd && h('div', { class: 'small dim' }, 'in ' + s.cwd),
          h(
            'div',
            { class: 'row wrap' },
            h(
              'button',
              {
                class: 'primary',
                onclick: () => {
                  if (me.term.job) return toast('Something is still running in the terminal. Stop it first.', true);
                  if (s.cwd) me.term.cwd = s.cwd;
                  me.tab = 'terminal';
                  showMachine();
                  runCommand(me.term, s.cmd);
                },
              },
              '▶ Run'
            ),
            h('button', { onclick: () => edit(i) }, 'Edit'),
            h(
              'button',
              {
                class: 'danger',
                onclick: () => {
                  if (!confirm(`Delete the script "${s.name}"?`)) return;
                  scripts.splice(i, 1);
                  save();
                },
              },
              'Delete'
            )
          )
        )
      ),
      scripts.length ? '' : h('div', { class: 'empty' }, 'Save the commands you run often, then start them here with one tap.'),
      h('button', { onclick: () => edit(scripts.length) }, '+ Add a script')
    );
  };
  draw();
}

// ---------- boot ----------

function boot() {
  if (!window.isSecureContext || !crypto.subtle) {
    view.replaceChildren(h('div', { class: 'pad' }, h('div', { class: 'card' }, 'This page needs HTTPS (or http://127.0.0.1) to do encryption.')));
    return;
  }
  let fromLink = null;
  try {
    const pair = new URLSearchParams(location.hash.slice(1)).get('pair');
    if (pair) pendingPair = normalizePairCode(pair);
    else if (location.hash.length > 1) fromLink = parseKeyInput(location.hash);
  } catch (e) {
    toast('The link is not valid: ' + e.message, true);
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (fromLink?.key) showSetup(fromLink.key, fromLink.broker);
  else if (localStorage.getItem(VAULT)) showUnlock();
  else {
    if (pendingPair) toast('Set up your dashboard on this device first, then scan the code again.', true);
    pendingPair = null;
    showSetup('');
  }
}

boot();
