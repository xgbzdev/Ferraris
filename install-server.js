#!/usr/bin/env node
/*
 * Ferraris installer + GitHub helper.
 *
 *   node install-server.js            -> start and stay running
 *   node install-server.js --once     -> exit after Ferraris has been installed
 *   PORT=9000 node install-server.js  -> custom port
 *   GITHUB_TOKEN=xxxx node ...        -> optional, raises GitHub's API rate limit
 *
 * 1) Open the printed URL in the Firefox OS browser on your phone and tap JAILBREAK.
 * 2) Keep this server running: old Firefox OS cannot talk to github.com over https (TLS 1.2),
 *    so Ferraris asks THIS computer to fetch repositories from GitHub and to build the app packages.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const ONCE = process.argv.includes('--once');
const APP_DIR = path.join(__dirname, 'app');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'manifest.webapp'), 'utf8'));
const WEBAPP_MIME = 'application/x-web-app-manifest+json';
const GH_API = process.env.FERRARIS_GH_API || 'https://api.github.com';
const GH_RAW = process.env.FERRARIS_GH_RAW || 'https://raw.githubusercontent.com';
const TOKEN = process.env.GITHUB_TOKEN || '';
const EXTRA_HOSTS = (process.env.FERRARIS_ALLOW_HOSTS || '').split(',').filter(Boolean); // for tests
const MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 30 * 1024 * 1024, MAX_FILES = 1000;

// ---------- minimal ZIP writer (deflate, no dependencies) ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}
// entries: [{ name: 'dir/file.txt', data: Buffer }]
function buildZipFromEntries(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : 0x800; // UTF-8 names

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Ferraris' own package. js/config.js is generated per request so the app knows which PC installed it.
const FERRARIS_FILES = walk(APP_DIR).filter((n) => n !== 'js/config.js')
  .map((name) => ({ name, data: fs.readFileSync(path.join(APP_DIR, name)) }));
const ferrarisZips = new Map();
function ferrarisZip(origin) {
  if (!ferrarisZips.has(origin)) {
    const cfg = Buffer.from('window.FERRARIS_PROXY = ' + JSON.stringify(origin) + ';\n');
    ferrarisZips.set(origin, buildZipFromEntries(FERRARIS_FILES.concat([{ name: 'js/config.js', data: cfg }])));
  }
  return ferrarisZips.get(origin);
}

// ---------- GitHub access (done by the PC, which has modern TLS) ----------
function hostAllowed(h) {
  h = h.toLowerCase();
  return h === 'github.com' || h === 'api.github.com' || h === 'codeload.github.com' ||
    h.endsWith('.githubusercontent.com') || h.endsWith('.github.io') || EXTRA_HOSTS.includes(h);
}
function fetchBuf(url, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Bad URL')); }
    if (!hostAllowed(u.hostname)) return reject(new Error('Host not allowed: ' + u.hostname));
    const headers = { 'User-Agent': 'Ferraris-helper', Accept: '*/*' };
    if (TOKEN && u.hostname === 'api.github.com') headers.Authorization = 'Bearer ' + TOKEN;
    const rq = (u.protocol === 'http:' ? http : https).get(u, { headers, timeout: 20000 }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        if (hops >= 5) return reject(new Error('Too many redirects'));
        return resolve(fetchBuf(new URL(r.headers.location, u).href, hops + 1));
      }
      const chunks = []; let size = 0;
      r.on('data', (c) => {
        size += c.length;
        if (size > MAX_TOTAL) rq.destroy(new Error('File too large')); else chunks.push(c);
      });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    rq.on('timeout', () => rq.destroy(new Error('GitHub timeout')));
    rq.on('error', reject);
  });
}
async function ghJson(p) {
  const r = await fetchBuf(GH_API + p);
  if (r.status === 404) throw new Error('Repository or branch not found (is it public?)');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub API rate limit reached - wait a bit or start the server with GITHUB_TOKEN=...');
  if (r.status !== 200) throw new Error('GitHub API HTTP ' + r.status);
  return JSON.parse(r.body.toString('utf8'));
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
async function rawFile(o, r, b, p) {
  const res = await fetchBuf(GH_RAW + '/' + o + '/' + r + '/' + encodeURIComponent(b) + '/' + encPath(p));
  if (res.status !== 200) throw new Error('GitHub raw HTTP ' + res.status + ' for ' + p);
  return res.body;
}

const plans = new Map(); // "owner/repo@branch" -> { at, promise }
const PLAN_TTL = 10 * 60 * 1000;
const hasRealPackage = (m) => typeof m.package_path === 'string' && /^https?:\/\//i.test(m.package_path) &&
  !/YOUR_|example\.com/i.test(m.package_path);

async function buildPlan(o, r, b) {
  console.log('  [github] reading ' + o + '/' + r + '@' + b);
  const tree = await ghJson('/repos/' + o + '/' + r + '/git/trees/' + encodeURIComponent(b) + '?recursive=1');
  const blobs = (tree.tree || []).filter((e) => e.type === 'blob');
  const manifests = blobs.map((e) => e.path).filter((p) => /(^|\/)manifest\.webapp$/.test(p))
    .sort((a, c) => a.split('/').length - c.split('/').length || a.localeCompare(c));
  if (!manifests.length) throw new Error('No manifest.webapp found in this repository');

  const found = [];
  for (const p of manifests.slice(0, 6)) {
    try { found.push({ path: p, dir: p.slice(0, -'manifest.webapp'.length), json: JSON.parse((await rawFile(o, r, b, p)).toString('utf8').replace(/^﻿/, '')) }); }
    catch (e) { console.log('  [github] skipping ' + p + ': ' + e.message); }
  }
  if (!found.length) throw new Error('manifest.webapp is not valid JSON');

  // 1) a manifest with a real, working package_path wins; 2) otherwise package the folder of the first
  //    manifest that describes an app (has launch_path or no package_path at all).
  let pick = found.find((f) => hasRealPackage(f.json));
  let mode = 'remote';
  if (!pick) {
    mode = 'package';
    pick = found.find((f) => f.json.launch_path) || found.find((f) => !f.json.package_path) || found[0];
  }
  const plan = { mode, manifest: pick.json, dir: pick.dir, manifestPath: pick.path };

  if (mode === 'package') {
    const files = blobs.filter((e) => e.path.startsWith(pick.dir) && !/(^|\/)\.git(hub)?\//.test(e.path) &&
      !(pick.dir === '' && /\.zip$/i.test(e.path)));
    if (files.length > MAX_FILES) throw new Error('Too many files to package (' + files.length + ')');
    const total = files.reduce((n, f) => n + (f.size || 0), 0);
    if (total > MAX_TOTAL) throw new Error('Repository too big to package (' + Math.round(total / 1048576) + ' MB)');
    const big = files.find((f) => (f.size || 0) > MAX_FILE);
    if (big) throw new Error('File too big: ' + big.path);
    const entries = new Array(files.length);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < files.length) {
        const i = next++;
        entries[i] = { name: files[i].path.slice(pick.dir.length), data: await rawFile(o, r, b, files[i].path) };
      }
    }));
    plan.zip = buildZipFromEntries(entries);
    plan.hash = crc32(plan.zip).toString(16);
    console.log('  [github] packaged ' + files.length + ' files from "' + (pick.dir || '/') + '" (' + (plan.zip.length / 1024).toFixed(1) + ' KB)');
  } else {
    plan.packageUrl = pick.json.package_path;
    console.log('  [github] using package_path ' + plan.packageUrl);
  }
  return plan;
}
function getPlan(o, r, b) {
  const key = o + '/' + r + '@' + b;
  const hit = plans.get(key);
  if (hit && Date.now() - hit.at < PLAN_TTL) return hit.promise;
  const promise = buildPlan(o, r, b);
  plans.set(key, { at: Date.now(), promise });
  promise.catch(() => plans.delete(key));
  return promise;
}
async function repoBranch(o, r, b) {
  if (b) return { branch: b, description: '' };
  try {
    const info = await ghJson('/repos/' + o + '/' + r);
    return { branch: info.default_branch || 'main', description: info.description || '' };
  } catch (e) {
    if (/rate limit/.test(e.message)) return { branch: 'main', description: '' }; // can't ask: guess
    throw e;
  }
}

// ---------- pages ----------
// Written in plain ES5 / old CSS so even very old Firefox OS browsers (Gecko 18+) can render it.
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PAGE_CSS = `
html, body { margin: 0; padding: 0; background: #000; color: #fff; font-family: sans-serif; }
body { text-align: center; padding: 12% 0 24px; }
h1 { margin: 0 0 24px; font-size: 28px; letter-spacing: 2px; text-transform: uppercase; }
#msg { margin: 0 auto 24px; width: 85%; font-size: 16px; color: #ccc; }
a { color: #8ab4ff; }
.btn-jailbreak {
  display: block; margin: 0 auto; width: 85%; max-width: 320px;
  background: #ff3b30; color: #fff; border: 0; padding: 24px 0;
  font-size: 24px; font-weight: bold; border-radius: 14px;
  -moz-box-shadow: 0 6px 15px rgba(255,59,48,.4); box-shadow: 0 6px 15px rgba(255,59,48,.4);
}
.btn-jailbreak:active { background: #d32f2f; }
.btn-jailbreak[disabled] { background: #555; -moz-box-shadow: none; box-shadow: none; }
.small { font-size: 14px; color: #999; margin-top: 28px; }
pre { text-align: left; margin: 0 auto; width: 90%; white-space: pre-wrap; font-size: 15px; line-height: 1.5; }`;

function installPage(title, manifestPath, extra) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} Installer</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p id="msg">Tap the button below.</p>
<button id="jailbreak" class="btn-jailbreak" type="button">${manifestPath === '/ferraris.manifest' ? 'JAILBREAK' : 'INSTALL'}</button>
<p class="small">${extra || ''}<a href="/test">Connection test</a></p>
<script>
(function () {
  var btn = document.getElementById('jailbreak');
  var msg = document.getElementById('msg');
  var LABEL = btn.textContent;
  var PATH = ${JSON.stringify(manifestPath)};

  function say(t) { msg.textContent = t; }
  function reset() { btn.disabled = false; btn.textContent = LABEL; }

  function go() {
    var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
    var manifestUrl = origin + PATH + (PATH.indexOf('?') > -1 ? '&' : '?') + 't=' + new Date().getTime();
    if (!(navigator.mozApps && navigator.mozApps.installPackage)) {
      say('navigator.mozApps.installPackage is not supported by this browser. Open this page in the Firefox OS browser.');
      return;
    }
    try {
      btn.disabled = true;
      btn.textContent = 'WORKING...';
      say('Preparing the package (the first time can take a few seconds) and waiting for the phone to ask for confirmation...');
      var req = navigator.mozApps.installPackage(manifestUrl);
      req.onsuccess = function () {
        btn.textContent = 'DONE';
        say('Installed. You can close this page.');
        try { var x = new XMLHttpRequest(); x.open('POST', '/done?p=' + encodeURIComponent(PATH)); x.send(); } catch (e) {}
      };
      req.onerror = function () {
        reset();
        var e = req.error;
        var name = (e && (e.name || e.message)) || e || 'unknown error';
        say('Failed: ' + name + (name === 'DENIED' ? ' (you cancelled, or the app is already installed: remove the old one first)' : ''));
      };
    } catch (ex) {
      reset();
      say('Blocked: ' + ex.message);
    }
  }

  btn.onclick = go;
})();
</script>
<noscript><p>JavaScript is required.</p></noscript>
</body>
</html>`;
}

// Opened on the phone: shows whether the phone can reach GitHub directly and whether it can reach this PC.
function testPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ferraris connection test</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Connection test</h1>
<pre id="out">Running...</pre>
<p class="small"><a href="/">Back</a></p>
<script>
(function () {
  var out = document.getElementById('out');
  var lines = [];
  function add(t) { lines.push(t); out.textContent = lines.join('\\n\\n'); }
  function test(label, url, ok) {
    var r;
    try { r = new XMLHttpRequest(); r.open('GET', url + (url.indexOf('?') > -1 ? '&' : '?') + 't=' + new Date().getTime(), true); }
    catch (e) { add('[FAIL] ' + label + ': ' + e.message); return; }
    r.timeout = 15000;
    r.onload = function () { add((r.status >= 200 && r.status < 300 ? '[ OK ] ' : '[FAIL] ') + label + ' (HTTP ' + r.status + ')'); };
    r.onerror = function () { add('[FAIL] ' + label + ' - network error'); };
    r.ontimeout = function () { add('[FAIL] ' + label + ' - timeout'); };
    r.send();
  }
  test('1. This PC (http)', '/gh/ping');
  test('2. Via the PC to GitHub', '/gh/lookup/xgbzdev/test-app-firefoxos');
  test('3. Phone directly to GitHub (https)', 'https://api.github.com/zen');
  add('Meaning: 1 must be OK (phone and PC see each other). 2 OK = Ferraris can add repositories. 3 FAIL is normal on old Firefox OS: that is exactly why Ferraris goes through the PC.');
})();
</script>
</body>
</html>`;
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  const origin = 'http://' + (req.headers.host || ('localhost:' + PORT));
  const u = new URL(req.url, origin);
  const url = u.pathname;
  console.log('  ' + req.method + ' ' + url + (u.search ? '?...' : '') + '  <- ' + (req.socket.remoteAddress || '?'));

  // Always send Content-Length and close the connection: old Gecko browsers can sit forever on
  // chunked / keep-alive responses, which looks like an endless "loading" blank screen.
  const send = (code, type, body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(code, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Connection': 'close',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  const json = (code, obj, type) => send(code, type || 'application/json; charset=utf-8', JSON.stringify(obj));
  const fail = (e) => { console.log('    ! ' + e.message); json(500, { error: e.message }); };

  if (req.method === 'OPTIONS') return send(204, 'text/plain', '');
  if (url === '/' || url === '/index.html') return send(200, 'text/html; charset=utf-8', installPage(MANIFEST.name, '/ferraris.manifest'));
  if (url === '/test') return send(200, 'text/html; charset=utf-8', testPage());
  if (url === '/favicon.ico') return send(204, 'image/x-icon', '');

  if (url === '/ferraris.manifest') {
    const zip = ferrarisZip(origin);
    return json(200, {
      name: MANIFEST.name,
      package_path: origin + '/ferraris.zip?t=' + Date.now(),
      version: MANIFEST.version || '1.0.0',
      size: zip.length,
      developer: MANIFEST.developer,
    }, WEBAPP_MIME + '; charset=utf-8');
  }
  if (url === '/ferraris.zip') return send(200, 'application/zip', ferrarisZip(origin));

  if (url === '/done' && req.method === 'POST') {
    send(200, 'text/plain', 'ok');
    console.log('\n✔ An app was installed on the phone.');
    if (ONCE && u.searchParams.get('p') === '/ferraris.manifest') {
      console.log('Shutting down (--once).'); setTimeout(() => process.exit(0), 1500);
    }
    return;
  }

  // ----- GitHub helper -----
  const parts = url.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'gh' || parts[0] === 'i') {
    if (url === '/gh/ping') return json(200, { ok: true });

    if (url === '/gh/url') { // proxy for a repo's own package_path (allow-listed GitHub hosts only)
      return fetchBuf(u.searchParams.get('u') || '').then((r) => {
        if (r.status !== 200) return json(502, { error: 'GitHub HTTP ' + r.status });
        send(200, 'application/zip', r.body);
      }, fail);
    }

    const ok = /^[A-Za-z0-9_.-]+$/;
    const isInstall = parts[0] === 'i';
    const kind = isInstall ? 'i' : parts[1];
    const o = isInstall ? parts[1] : parts[2], r = isInstall ? parts[2] : parts[3];
    if (!o || !r || !ok.test(o) || !ok.test(r)) return json(400, { error: 'Use /gh/<kind>/<owner>/<repo>' });
    const b = u.searchParams.get('b') || '';
    const withBranch = async () => (await repoBranch(o, r, b));

    if (isInstall) { // /i/<owner>/<repo>: install page to open in the phone browser
      const target = '/gh/mini/' + o + '/' + r + (b ? '?b=' + encodeURIComponent(b) : '');
      return send(200, 'text/html; charset=utf-8', installPage(o + '/' + r, target, ''));
    }

    if (kind === 'lookup') { // used by Ferraris: find branch, read manifest, build the package
      return withBranch().then(async (br) => {
        const plan = await getPlan(o, r, br.branch);
        const m = plan.manifest, icons = {};
        Object.keys(m.icons || {}).forEach((sz) => {
          const p = String(m.icons[sz]);
          icons[sz] = /^https?:/i.test(p) ? p
            : '/gh/raw/' + o + '/' + r + '/' + encPath(path.posix.join(plan.dir, p.replace(/^\//, ''))) + '?b=' + encodeURIComponent(br.branch);
        });
        json(200, {
          id: o + '/' + r, branch: br.branch, description: br.description, mode: plan.mode,
          manifest: { name: m.name, description: m.description, version: m.version, icons },
          mini: '/gh/mini/' + o + '/' + r + '?b=' + encodeURIComponent(br.branch),
        });
      }).catch(fail);
    }

    if (kind === 'mini') { // the mini-manifest that mozApps.installPackage() reads
      return withBranch().then(async (br) => {
        const plan = await getPlan(o, r, br.branch), m = plan.manifest;
        const mini = { name: m.name || r, version: m.version || '1.0.0', developer: m.developer || { name: o } };
        if (plan.mode === 'package') {
          mini.package_path = origin + '/gh/pkg/' + o + '/' + r + '?b=' + encodeURIComponent(br.branch) + '&v=' + plan.hash;
          mini.size = plan.zip.length;
        } else {
          mini.package_path = origin + '/gh/url?u=' + encodeURIComponent(plan.packageUrl);
        }
        json(200, mini, WEBAPP_MIME + '; charset=utf-8');
      }).catch(fail);
    }

    if (kind === 'pkg') {
      return withBranch().then(async (br) => {
        const plan = await getPlan(o, r, br.branch);
        if (!plan.zip) return json(404, { error: 'This repo uses its own package_path' });
        send(200, 'application/zip', plan.zip);
      }).catch(fail);
    }

    if (kind === 'raw') { // single file (icons)
      const file = parts.slice(4).join('/');
      return withBranch().then(async (br) => {
        const body = await rawFile(o, r, br.branch, file);
        const ext = (file.split('.').pop() || '').toLowerCase();
        const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
        send(200, types[ext] || 'application/octet-stream', body);
      }).catch(fail);
    }
  }
  send(404, 'text/plain', 'Not found');
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? 'Port ' + PORT + ' is already in use. Try: PORT=9000 node install-server.js'
    : 'Server error: ' + e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  // Node 18.0-18.3 reports family as the number 4 instead of 'IPv4'.
  const ips = [].concat(...Object.values(os.networkInterfaces()))
    .filter((i) => (i.family === 'IPv4' || i.family === 4) && !i.internal).map((i) => i.address);
  console.log('Ferraris installer + GitHub helper (' + (ferrarisZip('http://localhost:' + PORT).length / 1024).toFixed(1) + ' KB package)\n');
  console.log('On your phone (same Wi-Fi), open the Firefox OS browser at:\n');
  (ips.length ? ips : ['localhost']).forEach((ip) => console.log('    http://' + ip + ':' + PORT + '/'));
  console.log('\nTap the big red JAILBREAK button. Keep this window open afterwards: Ferraris uses it to reach GitHub.');
  console.log('Phone cannot open the page?  Open  http://<ip>:' + PORT + '/test  or see README.md > Troubleshooting.');
  console.log('If nothing is logged below when the phone opens the page, the phone cannot reach this PC (firewall / different Wi-Fi).\n');
});
