// Builds a standalone executable for the current OS: bundles reach.js and the dashboard into one script,
// then embeds it in a copy of the Node.js binary (Node "single executable application").
//   node build.mjs                bundle + build dist/reach-dashboard-<os>-<arch>[.exe]
//   node build.mjs --inject-only  reuse an existing dist/reach.cjs (bundle made on another OS)
//   node build.mjs --smoke        run the built executable's --help
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform;
const out = path.join('dist', `reach-dashboard-${os}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
const bundle = path.join('dist', 'reach.cjs');
const blob = path.join('dist', 'sea.blob');

if (process.argv.includes('--smoke')) {
  const help = execFileSync(path.resolve(out), ['--help'], { encoding: 'utf8' });
  if (!help.includes(`reach ${pkg.version}`)) throw new Error('unexpected --help output:\n' + help);
  console.log(`${out} runs: ${help.split('\n')[0]}`);

  // Join a throwaway dashboard address, then check the background client, its startup entry and stopping it.
  const { webcrypto } = await import('node:crypto');
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const address = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'reach-smoke-'));
  const env = { ...process.env, REACH_HOME: home, REACH_RUN_NAME: 'reach-smoke', REACH_NO_TRAY: '1' };
  const installed = path.join(home, 'bin', process.platform === 'win32' ? 'reach.exe' : 'reach');
  const run = (file, args) => execFileSync(file, args, { env, encoding: 'utf8' });
  const ping = () => fetch('http://127.0.0.1:7788/api/ping').then((r) => r.json(), () => null);
  try {
    console.log(run(path.resolve(out), ['join', address, '--port', '7788']).trim().split('\n')[0]);
    if (!(await ping())?.clientOnly) throw new Error('the background client is not running');
    console.log('background client running from', installed);
    console.log(run(installed, ['autostart', 'off', '--port', '7788']).trim());
    console.log(run(installed, ['autostart', 'on', '--port', '7788']).trim());
    console.log(run(installed, ['autostart', 'off', '--port', '7788']).trim());
    console.log(run(installed, ['stop', '--port', '7788']).trim());
    if (await ping()) throw new Error('the background client did not stop');
  } finally {
    try { run(installed, ['stop', '--port', '7788']); } catch {}
    try { run(installed, ['autostart', 'off', '--port', '7788']); } catch {}
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log('join, background, startup entry and stop all work on ' + process.platform);
  process.exit(0);
}

fs.mkdirSync('dist', { recursive: true });

if (!process.argv.includes('--inject-only')) {
  const { build } = await import('esbuild');
  const assets = Object.fromEntries(fs.readdirSync('docs').map((f) => [f, fs.readFileSync(path.join('docs', f), 'utf8')]));
  const info = { version: pkg.version, homepage: pkg.homepage };
  await build({
    entryPoints: ['reach.js'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundle,
    external: ['bufferutil', 'utf-8-validate'],
    // The two WS_NO_* switches stop the bundled ws library from probing for optional native add-ons.
    banner: { js: `process.env.WS_NO_BUFFER_UTIL = process.env.WS_NO_UTF_8_VALIDATE = '1';\nconst __REACH_ASSETS__ = ${JSON.stringify(assets)};\nconst __REACH_PKG__ = ${JSON.stringify(info)};` },
    logOverride: { 'empty-import-meta': 'silent' },
    // 'debug' (a dependency of mqtt) probes for this optional module; an empty stand-in keeps the executable quiet.
    plugins: [
      {
        name: 'stub-optional',
        setup(b) {
          b.onResolve({ filter: /^supports-color$/ }, () => ({ path: 'supports-color', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};' }));
        },
      },
    ],
  });
}

const config = path.join('dist', 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', out]);
const { inject } = await import('postject');
await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', out]);
console.log(`built ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(0)} MB)`);
