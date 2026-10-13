(function () {
  'use strict';
  // Plain ES5 on purpose: Firefox OS 1.x browsers (Gecko 18-26) do not know newer JavaScript.
  var KEY = 'ferraris.repos';
  var PKEY = 'ferraris.proxy';
  var $ = function (s) { return document.querySelector(s); };
  var repos = load();
  var installedUrls = [];
  var proxy = loadProxy();

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(repos)); } catch (e) {} }
  function say(t) { $('#status').textContent = t || ''; }
  function sayProxy(t) { $('#proxystatus').textContent = t || ''; }

  // ---- helper server address (set automatically by the installer, editable if the PC's IP changes) ----
  function normProxy(v) {
    v = (v || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v;
  }
  function loadProxy() {
    var v = null;
    try { v = localStorage.getItem(PKEY); } catch (e) {}
    return normProxy(v === null ? window.FERRARIS_PROXY : v);
  }

  // ---- HTTP ----
  // Returns parsed JSON. Errors sent by the PC helper ({"error": "..."}) keep their message and
  // are flagged fromServer so we do not pointlessly retry directly against GitHub.
  function xhr(url, cb) {
    var r;
    try { r = new XMLHttpRequest({ mozSystem: true, mozAnon: true }); } catch (e) { r = new XMLHttpRequest(); }
    try { r.open('GET', url, true); } catch (e) { return cb(new Error('Bad address: ' + url)); }
    r.onload = function () {
      var data = null;
      try { data = JSON.parse(r.responseText); } catch (e) {}
      if (r.status < 200 || r.status >= 300) {
        var err = new Error((data && data.error) || ('HTTP ' + r.status));
        err.fromServer = true;
        return cb(err);
      }
      if (data === null) return cb(new Error('Invalid JSON'));
      cb(null, data);
    };
    r.onerror = function () { cb(new Error('Network error (cannot connect)')); };
    r.ontimeout = function () { cb(new Error('Timeout')); };
    r.timeout = 60000; // the helper may need a few seconds to download the repo from GitHub
    r.send();
  }

  function parseRepo(text) {
    var p = text.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '')
      .replace(/\.git$/, '').replace(/\/+$/, '').split('/');
    return p.length >= 2 && p[0] && p[1] ? { owner: p[0], name: p[1] } : null;
  }

  // ---- Way 1: through the PC (works even if the phone's TLS is too old for GitHub) ----
  function lookupViaPc(repo, cb) {
    if (!proxy) return cb(new Error('no helper server address set'));
    xhr(proxy + '/gh/lookup/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name), function (err, d) {
      if (err) return cb(err);
      cb(null, {
        via: 'pc', branch: d.branch, mini: d.mini, manifest: d.manifest, ghDesc: d.description || ''
      });
    });
  }

  // ---- Way 2: directly from the phone (needs a phone that can open https://github.com) ----
  function lookupDirect(repo, cb) {
    xhr('https://api.github.com/repos/' + repo.owner + '/' + repo.name, function (err, data) {
      var list = !err && data.default_branch ? [data.default_branch] : ['main', 'master'];
      var desc = (!err && data.description) || '';
      (function tryBranch(i, lastErr) {
        if (i >= list.length) return cb(new Error('No manifest.webapp found' + (lastErr ? ' - ' + lastErr.message : '')));
        var base = 'https://raw.githubusercontent.com/' + repo.owner + '/' + repo.name + '/' + list[i] + '/';
        xhr(base + 'manifest.webapp', function (e2, manifest) {
          if (e2) return tryBranch(i + 1, e2);
          cb(null, {
            via: 'direct', branch: list[i], manifest: manifest, ghDesc: desc,
            rawUrl: base + 'manifest.webapp',
            pagesUrl: 'https://' + repo.owner.toLowerCase() + '.github.io/' + repo.name + '/manifest.webapp'
          });
        });
      })(0);
    });
  }

  function addRepo(text) {
    var repo = parseRepo(text);
    if (!repo) return say('Use the format user/repository');
    var id = repo.owner + '/' + repo.name;
    if (repos.some(function (r) { return r.id === id; })) return say('Already in your list.');
    say('Looking up ' + id + '... (the first time it can take a few seconds)');
    $('#add').disabled = true;

    function done(res) {
      $('#add').disabled = false;
      res.id = id; res.owner = repo.owner; res.name = repo.name;
      repos.unshift(res);
      save(); say(''); $('#repo').value = ''; render();
    }
    function failed(msg) { $('#add').disabled = false; say(id + ': ' + msg); }

    lookupViaPc(repo, function (e1, res) {
      if (res) return done(res);
      if (e1.fromServer) return failed(e1.message);              // the PC reached GitHub: real answer
      lookupDirect(repo, function (e2, res2) {
        if (res2) return done(res2);
        failed((proxy ? 'Helper: ' + e1.message + ' | ' : 'No helper server address set | ') +
          'Direct: ' + e2.message + (proxy ? '' : '. Set the helper server address below.'));
      });
    });
  }

  function iconUrl(r) {
    var icons = r.manifest.icons || {};
    var sizes = Object.keys(icons).map(Number).sort(function (a, b) { return b - a; });
    if (!sizes.length) return '';
    var p = icons[sizes[0]];
    if (/^https?:/.test(p)) return p;
    if (r.via === 'pc') return proxy + p;
    return r.rawUrl.replace(/manifest\.webapp$/, '') + p.replace(/^\//, '');
  }

  // ---- installed state ----
  function miniMatch(url, r) { // installed manifestURL like http://pc:8080/gh/mini/owner/repo?b=main
    var m = '/gh/mini/' + r.id, i = url.indexOf(m);
    return i > -1 && (url.length === i + m.length || url.charAt(i + m.length) === '?');
  }
  function isInstalled(r) {
    return installedUrls.some(function (u) {
      return miniMatch(u, r) || (r.rawUrl && u === r.rawUrl) || (r.pagesUrl && u === r.pagesUrl);
    });
  }

  function refreshInstalled(cb) {
    if (!navigator.mozApps || !navigator.mozApps.getInstalled) return cb && cb();
    var req = navigator.mozApps.getInstalled();
    req.onsuccess = function () {
      installedUrls = (req.result || []).map(function (a) { return a.manifestURL; });
      if (cb) cb();
    };
    req.onerror = function () { if (cb) cb(); };
  }

  // Installs with navigator.mozApps.installPackage(). The URL must be a mini-manifest
  // (JSON with name, version and package_path) served as application/x-web-app-manifest+json.
  function install(r, btn) {
    if (!navigator.mozApps || !navigator.mozApps.installPackage) {
      return say('installPackage is not available on this device.');
    }
    var urls;
    if (r.via === 'pc') {
      if (!proxy) return say('Set the helper server address below first.');
      urls = [proxy + r.mini];
    } else {
      if (!r.manifest.package_path) return say('This repo\'s manifest.webapp has no "package_path". Use the helper server instead (set its address below, then Remove and Add the repo again).');
      urls = [r.rawUrl, r.pagesUrl];
    }
    var i = 0, lastErr = '';
    btn.disabled = true; btn.textContent = 'Installing...';
    say('Preparing ' + (r.manifest.name || r.name) + '...');
    function reset() { btn.disabled = false; btn.textContent = 'Install'; }
    (function next() {
      if (i >= urls.length) {
        reset();
        return say('Install failed (' + lastErr + ').' + (r.via === 'pc'
          ? ' Check that the helper server is reachable. Alternative: open ' + proxy + '/i/' + r.id + ' in the phone browser.'
          : ' The mini-manifest must be served as application/x-web-app-manifest+json.'));
      }
      var req = navigator.mozApps.installPackage(urls[i++]);
      req.onsuccess = function () { say((r.manifest.name || r.name) + ' installed.'); refreshInstalled(render); };
      req.onerror = function () {
        lastErr = (req.error && (req.error.name || req.error)) || 'unknown error';
        if (lastErr === 'DENIED') { reset(); return say('Installation cancelled (or already installed: remove the old copy first).'); }
        next();
      };
    })();
  }

  function launch(r) {
    var req = navigator.mozApps.getInstalled();
    req.onsuccess = function () {
      (req.result || []).forEach(function (a) {
        if (miniMatch(a.manifestURL, r) || a.manifestURL === r.rawUrl || a.manifestURL === r.pagesUrl) a.launch();
      });
    };
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function render() {
    var ul = $('#list'); ul.innerHTML = '';
    $('#empty').style.display = repos.length ? 'none' : 'block';
    repos.forEach(function (r) {
      var li = el('li');
      var img = el('img'); img.src = iconUrl(r); img.alt = '';
      var info = el('div', 'info');
      info.appendChild(el('div', 'name', r.manifest.name || r.name));
      info.appendChild(el('div', 'meta', r.id + ' @ ' + r.branch + (r.manifest.version ? ' · v' + r.manifest.version : '')));
      info.appendChild(el('div', 'desc', r.manifest.description || r.ghDesc || ''));
      var row = el('div', 'row');
      var main = el('button', '', isInstalled(r) ? 'Open' : 'Install');
      main.onclick = function () { isInstalled(r) ? launch(r) : install(r, main); };
      var rm = el('button', 'rm', 'Remove');
      rm.onclick = function () { repos = repos.filter(function (x) { return x.id !== r.id; }); save(); render(); };
      row.appendChild(main); row.appendChild(rm);
      info.appendChild(row);
      li.appendChild(img); li.appendChild(info);
      ul.appendChild(li);
    });
  }

  function saveProxy() {
    proxy = normProxy($('#proxy').value);
    try { localStorage.setItem(PKEY, proxy); } catch (e) {}
    $('#proxy').value = proxy;
    if (!proxy) return sayProxy('Helper server disabled (direct connection only).');
    sayProxy('Testing ' + proxy + '...');
    xhr(proxy + '/gh/ping', function (err) {
      sayProxy(err ? 'Cannot reach the helper server: ' + err.message + '. Is it running (PC: install-server.js, or your web host), and can the phone reach it over http?' : 'Helper server reachable.');
      render();
    });
  }

  $('#proxy').value = proxy;
  $('#saveproxy').onclick = saveProxy;
  $('#add').onclick = function () { addRepo($('#repo').value); };
  $('#repo').onkeydown = function (e) { if (e.keyCode === 13) addRepo(this.value); };
  render();
  refreshInstalled(render);
})();
