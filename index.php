<?php
/*
 * Ferraris host (PHP) - the always-on version of install-server.js.
 *
 * Upload this folder (index.php, .htaccess, app/) to a web host that serves PLAIN http:// and runs PHP
 * (PHP 7.0+, extensions curl + zip). Then on the phone open  http://YOUR-HOST/  and tap JAILBREAK.
 *
 * Optional settings (edit here or set as environment variables):
 */
$CONFIG = array(
    'github_token' => getenv('GITHUB_TOKEN') ?: '',          // optional: raises GitHub's 60 requests/hour limit
    'gh_api'       => getenv('FERRARIS_GH_API') ?: 'https://api.github.com',
    'gh_raw'       => getenv('FERRARIS_GH_RAW') ?: 'https://raw.githubusercontent.com',
    'extra_hosts'  => array_filter(explode(',', getenv('FERRARIS_ALLOW_HOSTS') ?: '')), // for tests only
    'cache_dir'    => getenv('FERRARIS_CACHE') ?: (sys_get_temp_dir() . '/ferraris-cache'),
    'cache_ttl'    => 600,
    'max_file'     => 5 * 1024 * 1024,
    'max_total'    => 30 * 1024 * 1024,
    'max_files'    => 1000,
);
$WEBAPP_MIME = 'application/x-web-app-manifest+json';
$APP_DIR = __DIR__ . '/app';
@set_time_limit(120);

// ---------- helpers ----------
function out($code, $type, $body) {
    http_response_code($code);
    header('Content-Type: ' . $type);
    header('Content-Length: ' . strlen($body));
    header('Cache-Control: no-store');
    header('Connection: close');
    header('Access-Control-Allow-Origin: *');
    if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') echo $body;
    exit;
}
function out_json($code, $obj, $type = 'application/json; charset=utf-8') {
    out($code, $type, json_encode($obj, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
}
function fail_msg($msg) { out_json(500, array('error' => $msg)); }
function esc($t) { return htmlspecialchars($t, ENT_QUOTES, 'UTF-8'); }
function enc_path($p) { return implode('/', array_map('rawurlencode', explode('/', $p))); }
function starts_with($s, $p) { return substr($s, 0, strlen($p)) === $p; }
function ends_with($s, $p) { return $p === '' || substr($s, -strlen($p)) === $p; }

function host_allowed($h) {
    global $CONFIG;
    $h = strtolower($h);
    return $h === 'github.com' || $h === 'api.github.com' || $h === 'codeload.github.com' ||
        ends_with($h, '.githubusercontent.com') || ends_with($h, '.github.io') ||
        in_array($h, $CONFIG['extra_hosts'], true);
}

// GET with manual redirect handling so every hop is checked against the allow-list.
function fetch_buf($url, $hops = 0) {
    global $CONFIG;
    $u = parse_url($url);
    if (!$u || empty($u['host']) || empty($u['scheme'])) throw new Exception('Bad URL');
    if (!host_allowed($u['host'])) throw new Exception('Host not allowed: ' . $u['host']);
    $headers = array('User-Agent: Ferraris-host', 'Accept: */*');
    if ($CONFIG['github_token'] && $u['host'] === 'api.github.com') $headers[] = 'Authorization: Bearer ' . $CONFIG['github_token'];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 15, CURLOPT_TIMEOUT => 40, CURLOPT_HTTPHEADER => $headers,
        ));
        $raw = curl_exec($ch);
        if ($raw === false) { $e = curl_error($ch); curl_close($ch); throw new Exception('Cannot reach GitHub from this web host: ' . $e); }
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $hsize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);
        $head = substr($raw, 0, $hsize); $body = substr($raw, $hsize);
        $location = preg_match('/^Location:\s*(.+)$/mi', $head, $m) ? trim($m[1]) : '';
    } else {
        $ctx = stream_context_create(array('http' => array('method' => 'GET', 'header' => implode("\r\n", $headers),
            'follow_location' => 0, 'ignore_errors' => true, 'timeout' => 40)));
        $body = @file_get_contents($url, false, $ctx);
        if ($body === false) throw new Exception('Cannot reach GitHub from this web host (curl missing and allow_url_fopen off?)');
        $status = 0; $location = '';
        foreach ($http_response_header as $l) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $l, $m)) $status = (int)$m[1];
            if (stripos($l, 'Location:') === 0) $location = trim(substr($l, 9));
        }
    }
    if (in_array($status, array(301, 302, 303, 307, 308), true) && $location !== '') {
        if ($hops >= 5) throw new Exception('Too many redirects');
        if (!preg_match('#^https?://#i', $location)) {
            $location = $u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '') .
                (starts_with($location, '/') ? '' : '/') . $location;
        }
        return fetch_buf($location, $hops + 1);
    }
    if (strlen($body) > $CONFIG['max_total']) throw new Exception('File too large');
    return array('status' => $status, 'body' => $body);
}
function gh_json($path) {
    global $CONFIG;
    $r = fetch_buf($CONFIG['gh_api'] . $path);
    if ($r['status'] === 404) throw new Exception('Repository or branch not found (is it public?)');
    if ($r['status'] === 403 || $r['status'] === 429) throw new Exception('GitHub API rate limit reached - wait a bit or set github_token in index.php');
    if ($r['status'] !== 200) throw new Exception('GitHub API HTTP ' . $r['status']);
    $j = json_decode($r['body'], true);
    if (!is_array($j)) throw new Exception('Bad answer from GitHub');
    return $j;
}
function raw_file($o, $r, $b, $p) {
    global $CONFIG;
    $res = fetch_buf($CONFIG['gh_raw'] . '/' . $o . '/' . $r . '/' . rawurlencode($b) . '/' . enc_path($p));
    if ($res['status'] !== 200) throw new Exception('GitHub raw HTTP ' . $res['status'] . ' for ' . $p);
    return $res['body'];
}
function repo_branch($o, $r, $b) {
    if ($b !== '') return array('branch' => $b, 'description' => '');
    try {
        $info = gh_json('/repos/' . $o . '/' . $r);
        return array('branch' => !empty($info['default_branch']) ? $info['default_branch'] : 'main',
                     'description' => isset($info['description']) ? (string)$info['description'] : '');
    } catch (Exception $e) {
        if (strpos($e->getMessage(), 'rate limit') !== false) return array('branch' => 'main', 'description' => '');
        throw $e;
    }
}
function has_real_package($m) {
    return isset($m['package_path']) && is_string($m['package_path']) && preg_match('#^https?://#i', $m['package_path']) &&
        !preg_match('/YOUR_|example\.com/i', $m['package_path']);
}

// ---------- plan: which folder becomes the app package (cached on disk) ----------
function build_plan($o, $r, $b) {
    global $CONFIG;
    $tree = gh_json('/repos/' . $o . '/' . $r . '/git/trees/' . rawurlencode($b) . '?recursive=1');
    $blobs = array();
    foreach (isset($tree['tree']) ? $tree['tree'] : array() as $e) if ($e['type'] === 'blob') $blobs[] = $e;
    $manifests = array();
    foreach ($blobs as $e) if (preg_match('#(^|/)manifest\.webapp$#', $e['path'])) $manifests[] = $e['path'];
    usort($manifests, function ($a, $c) {
        $d = substr_count($a, '/') - substr_count($c, '/');
        return $d !== 0 ? $d : strcmp($a, $c);
    });
    if (!$manifests) throw new Exception('No manifest.webapp found in this repository');

    $found = array();
    foreach (array_slice($manifests, 0, 6) as $p) {
        $txt = preg_replace('/^\xEF\xBB\xBF/', '', raw_file($o, $r, $b, $p));
        $j = json_decode($txt, true);
        if (is_array($j)) $found[] = array('path' => $p, 'dir' => substr($p, 0, -strlen('manifest.webapp')), 'json' => $j);
    }
    if (!$found) throw new Exception('manifest.webapp is not valid JSON');

    $pick = null; $mode = 'remote';
    foreach ($found as $f) if (has_real_package($f['json'])) { $pick = $f; break; }
    if (!$pick) {
        $mode = 'package';
        foreach ($found as $f) if (!empty($f['json']['launch_path'])) { $pick = $f; break; }
        if (!$pick) foreach ($found as $f) if (empty($f['json']['package_path'])) { $pick = $f; break; }
        if (!$pick) $pick = $found[0];
    }
    $plan = array('mode' => $mode, 'manifest' => $pick['json'], 'dir' => $pick['dir'], 'manifestPath' => $pick['path']);

    if ($mode === 'package') {
        $files = array(); $total = 0;
        foreach ($blobs as $e) {
            $p = $e['path'];
            if (!starts_with($p, $pick['dir'])) continue;
            if (preg_match('#(^|/)\.git(hub)?/#', $p)) continue;
            if ($pick['dir'] === '' && preg_match('/\.zip$/i', $p)) continue;
            $size = isset($e['size']) ? (int)$e['size'] : 0;
            if ($size > $CONFIG['max_file']) throw new Exception('File too big: ' . $p);
            $total += $size; $files[] = $p;
        }
        if (count($files) > $CONFIG['max_files']) throw new Exception('Too many files to package (' . count($files) . ')');
        if ($total > $CONFIG['max_total']) throw new Exception('Repository too big to package (' . round($total / 1048576) . ' MB)');
        $tmp = tempnam(sys_get_temp_dir(), 'frz');
        $zip = new ZipArchive();
        if ($zip->open($tmp, ZipArchive::OVERWRITE | ZipArchive::CREATE) !== true) throw new Exception('Cannot create zip (is the zip extension enabled?)');
        foreach ($files as $p) $zip->addFromString(substr($p, strlen($pick['dir'])), raw_file($o, $r, $b, $p));
        $zip->close();
        $data = file_get_contents($tmp); @unlink($tmp);
        $plan['hash'] = dechex(crc32($data));
        $plan['size'] = strlen($data);
        $plan['zip'] = $data;
    } else {
        $plan['packageUrl'] = $pick['json']['package_path'];
    }
    return $plan;
}
function get_plan($o, $r, $b) {
    global $CONFIG;
    $dir = $CONFIG['cache_dir'];
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    $key = $dir . '/' . md5($o . '/' . $r . '@' . $b);
    if (is_file($key . '.json') && time() - filemtime($key . '.json') < $CONFIG['cache_ttl']) {
        $plan = json_decode(file_get_contents($key . '.json'), true);
        if (is_array($plan) && ($plan['mode'] === 'remote' || is_file($key . '.zip'))) {
            if ($plan['mode'] === 'package') $plan['zip'] = file_get_contents($key . '.zip');
            return $plan;
        }
    }
    $plan = build_plan($o, $r, $b);
    $meta = $plan; unset($meta['zip']);
    if (isset($plan['zip'])) @file_put_contents($key . '.zip', $plan['zip']);
    @file_put_contents($key . '.json', json_encode($meta));
    return $plan;
}

// ---------- Ferraris' own package ----------
function ferraris_zip($root) {
    global $APP_DIR;
    $tmp = tempnam(sys_get_temp_dir(), 'frz');
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE | ZipArchive::CREATE) !== true) throw new Exception('Cannot create zip (zip extension missing)');
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($APP_DIR, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (!$f->isFile()) continue;
        $name = str_replace('\\', '/', substr($f->getPathname(), strlen($APP_DIR) + 1));
        if ($name === 'js/config.js') continue;
        $zip->addFile($f->getPathname(), $name);
    }
    $zip->addFromString('js/config.js', 'window.FERRARIS_PROXY = ' . json_encode($root, JSON_UNESCAPED_SLASHES) . ";\n");
    $zip->close();
    $data = file_get_contents($tmp); @unlink($tmp);
    return $data;
}

// ---------- pages (plain ES5 so Firefox OS 1.x browsers can run them) ----------
$PAGE_CSS = 'html,body{margin:0;padding:0;background:#000;color:#fff;font-family:sans-serif}body{text-align:center;padding:12% 0 24px}
h1{margin:0 0 24px;font-size:28px;letter-spacing:2px;text-transform:uppercase}#msg{margin:0 auto 24px;width:85%;font-size:16px;color:#ccc}
a{color:#8ab4ff}.btn-jailbreak{display:block;margin:0 auto;width:85%;max-width:320px;background:#ff3b30;color:#fff;border:0;padding:24px 0;font-size:24px;font-weight:bold;border-radius:14px}
.btn-jailbreak:active{background:#d32f2f}.btn-jailbreak[disabled]{background:#555}.small{font-size:14px;color:#999;margin-top:28px}
pre{text-align:left;margin:0 auto;width:90%;white-space:pre-wrap;font-size:15px;line-height:1.5}';

function install_page($title, $manifestPath, $label) {
    global $PAGE_CSS;
    ob_start(); ?>
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title><?= esc($title) ?> Installer</title><style><?= $PAGE_CSS ?></style></head>
<body>
<h1><?= esc($title) ?></h1>
<p id="msg">Tap the button below.</p>
<button id="jailbreak" class="btn-jailbreak" type="button"><?= esc($label) ?></button>
<p class="small"><a id="testlink" href="#">Connection test</a></p>
<script>
(function () {
  var btn = document.getElementById('jailbreak');
  var msg = document.getElementById('msg');
  var LABEL = btn.textContent;
  var PATH = <?= json_encode($manifestPath) ?>;          // relative to the Ferraris host root
  var ROOT = <?= json_encode(root_url()) ?>;             // e.g. http://host/ferraris
  document.getElementById('testlink').href = ROOT + '/test';
  function say(t) { msg.textContent = t; }
  function reset() { btn.disabled = false; btn.textContent = LABEL; }
  function go() {
    var manifestUrl = ROOT + PATH + (PATH.indexOf('?') > -1 ? '&' : '?') + 't=' + new Date().getTime();
    if (!(navigator.mozApps && navigator.mozApps.installPackage)) {
      say('navigator.mozApps.installPackage is not supported by this browser. Open this page in the Firefox OS browser.');
      return;
    }
    try {
      btn.disabled = true; btn.textContent = 'WORKING...';
      say('Preparing the package (the first time can take a few seconds) and waiting for the phone to ask for confirmation...');
      var req = navigator.mozApps.installPackage(manifestUrl);
      req.onsuccess = function () { btn.textContent = 'DONE'; say('Installed. You can close this page.'); };
      req.onerror = function () {
        reset();
        var e = req.error, name = (e && (e.name || e.message)) || e || 'unknown error';
        say('Failed: ' + name + (name === 'DENIED' ? ' (you cancelled, or the app is already installed: remove the old one first)' : ''));
      };
    } catch (ex) { reset(); say('Blocked: ' + ex.message); }
  }
  btn.onclick = go;
})();
</script>
<noscript><p>JavaScript is required.</p></noscript>
</body></html>
<?php return ob_get_clean();
}

function test_page() {
    global $PAGE_CSS;
    ob_start(); ?>
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ferraris connection test</title><style><?= $PAGE_CSS ?></style></head>
<body>
<h1>Connection test</h1>
<pre id="out">Running...</pre>
<p class="small"><a id="back" href="#">Back</a></p>
<script>
(function () {
  var ROOT = <?= json_encode(root_url()) ?>;
  document.getElementById('back').href = ROOT + '/';
  var out = document.getElementById('out'), lines = [];
  function add(t) { lines.push(t); out.textContent = lines.join('\n\n'); }
  function test(label, url) {
    var r;
    try { r = new XMLHttpRequest(); r.open('GET', url + (url.indexOf('?') > -1 ? '&' : '?') + 't=' + new Date().getTime(), true); }
    catch (e) { add('[FAIL] ' + label + ': ' + e.message); return; }
    r.timeout = 30000;
    r.onload = function () { add((r.status >= 200 && r.status < 300 ? '[ OK ] ' : '[FAIL] ') + label + ' (HTTP ' + r.status + ')' + (r.status >= 300 ? ' ' + r.responseText.slice(0, 120) : '')); };
    r.onerror = function () { add('[FAIL] ' + label + ' - network error'); };
    r.ontimeout = function () { add('[FAIL] ' + label + ' - timeout'); };
    r.send();
  }
  test('1. This host (http)', ROOT + '/gh/ping');
  test('2. Via the host to GitHub', ROOT + '/gh/lookup/xgbzdev/test-app-firefoxos');
  test('3. Phone directly to GitHub (https)', 'https://api.github.com/zen');
  add('Meaning: 1 must be OK. 2 OK = Ferraris can add repositories (FAIL with "Cannot reach GitHub from this web host" = this host blocks outgoing connections: try another host). 3 FAIL is normal on old Firefox OS.');
})();
</script>
</body></html>
<?php return ob_get_clean();
}

// ---------- routing ----------
// Works both with .htaccess rewrites (http://host/gh/ping) and without (http://host/index.php/gh/ping).
function parse_route() {
    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $path = rawurldecode($path === null ? '/' : $path);
    $i = strpos($path, '/index.php');
    if ($i !== false) { $root = substr($path, 0, $i + strlen('/index.php')); $route = substr($path, strlen($root)); }
    else {
        $sn = str_replace('\\', '/', $_SERVER['SCRIPT_NAME']);
        $root = basename($sn) === 'index.php' ? rtrim(dirname($sn), '/') : '';
        $route = substr($path, strlen($root));
    }
    return array(rtrim($root, '/'), $route === '' || $route === false ? '/' : $route);
}
list($ROOT_PATH, $ROUTE) = parse_route();
function root_url() {
    global $ROOT_PATH;
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ||
             (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
    return ($https ? 'https://' : 'http://') . $_SERVER['HTTP_HOST'] . $ROOT_PATH;
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') out(204, 'text/plain', '');
$root = root_url();
$u = parse_url($ROUTE, PHP_URL_PATH);
try {
    if ($ROUTE === '/' || $ROUTE === '/index.html') out(200, 'text/html; charset=utf-8', install_page('Ferraris', '/ferraris.manifest', 'JAILBREAK'));
    if ($ROUTE === '/test') out(200, 'text/html; charset=utf-8', test_page());
    if ($ROUTE === '/favicon.ico') out(204, 'image/x-icon', '');
    if ($ROUTE === '/done') out(200, 'text/plain', 'ok');

    if ($ROUTE === '/ferraris.manifest') {
        $m = json_decode(file_get_contents($APP_DIR . '/manifest.webapp'), true);
        $zip = ferraris_zip($root);
        out_json(200, array(
            'name' => $m['name'], 'package_path' => $root . '/ferraris.zip?t=' . time(),
            'version' => isset($m['version']) ? $m['version'] : '1.0.0', 'size' => strlen($zip),
            'developer' => isset($m['developer']) ? $m['developer'] : array('name' => 'Ferraris'),
        ), $WEBAPP_MIME . '; charset=utf-8');
    }
    if ($ROUTE === '/ferraris.zip') out(200, 'application/zip', ferraris_zip($root));

    $parts = array_values(array_filter(explode('/', $ROUTE), 'strlen'));
    if ($parts && ($parts[0] === 'gh' || $parts[0] === 'i')) {
        if ($ROUTE === '/gh/ping') out_json(200, array('ok' => true));
        if ($ROUTE === '/gh/url') {
            $r = fetch_buf(isset($_GET['u']) ? $_GET['u'] : '');
            if ($r['status'] !== 200) out_json(502, array('error' => 'GitHub HTTP ' . $r['status']));
            out(200, 'application/zip', $r['body']);
        }
        $isInstall = $parts[0] === 'i';
        $kind = $isInstall ? 'i' : (isset($parts[1]) ? $parts[1] : '');
        $o = $isInstall ? (isset($parts[1]) ? $parts[1] : '') : (isset($parts[2]) ? $parts[2] : '');
        $r = $isInstall ? (isset($parts[2]) ? $parts[2] : '') : (isset($parts[3]) ? $parts[3] : '');
        if (!preg_match('/^[A-Za-z0-9_.-]+$/', $o) || !preg_match('/^[A-Za-z0-9_.-]+$/', $r)) out_json(400, array('error' => 'Use /gh/<kind>/<owner>/<repo>'));
        $b = isset($_GET['b']) ? (string)$_GET['b'] : '';

        if ($isInstall) {
            $target = '/gh/mini/' . $o . '/' . $r . ($b !== '' ? '?b=' . rawurlencode($b) : '');
            out(200, 'text/html; charset=utf-8', install_page($o . '/' . $r, $target, 'INSTALL'));
        }
        $br = repo_branch($o, $r, $b);
        if ($kind === 'lookup') {
            $plan = get_plan($o, $r, $br['branch']);
            $m = $plan['manifest']; $icons = new stdClass();
            if (!empty($m['icons']) && is_array($m['icons'])) {
                foreach ($m['icons'] as $sz => $p) {
                    $p = (string)$p;
                    if (preg_match('#^https?:#i', $p)) { $icons->$sz = $p; continue; }
                    $parts2 = array(); // normalise dir + path
                    foreach (explode('/', $plan['dir'] . ltrim($p, '/')) as $seg) {
                        if ($seg === '' || $seg === '.') continue;
                        if ($seg === '..') { array_pop($parts2); continue; }
                        $parts2[] = $seg;
                    }
                    $icons->$sz = '/gh/raw/' . $o . '/' . $r . '/' . enc_path(implode('/', $parts2)) . '?b=' . rawurlencode($br['branch']);
                }
            }
            out_json(200, array(
                'id' => $o . '/' . $r, 'branch' => $br['branch'], 'description' => $br['description'], 'mode' => $plan['mode'],
                'manifest' => array('name' => isset($m['name']) ? $m['name'] : null, 'description' => isset($m['description']) ? $m['description'] : null,
                                    'version' => isset($m['version']) ? $m['version'] : null, 'icons' => $icons),
                'mini' => '/gh/mini/' . $o . '/' . $r . '?b=' . rawurlencode($br['branch']),
            ));
        }
        if ($kind === 'mini') {
            $plan = get_plan($o, $r, $br['branch']); $m = $plan['manifest'];
            $mini = array('name' => isset($m['name']) ? $m['name'] : $r, 'version' => isset($m['version']) ? $m['version'] : '1.0.0',
                          'developer' => isset($m['developer']) ? $m['developer'] : array('name' => $o));
            if ($plan['mode'] === 'package') {
                $mini['package_path'] = $root . '/gh/pkg/' . $o . '/' . $r . '?b=' . rawurlencode($br['branch']) . '&v=' . $plan['hash'];
                $mini['size'] = $plan['size'];
            } else {
                $mini['package_path'] = $root . '/gh/url?u=' . rawurlencode($plan['packageUrl']);
            }
            out_json(200, $mini, $WEBAPP_MIME . '; charset=utf-8');
        }
        if ($kind === 'pkg') {
            $plan = get_plan($o, $r, $br['branch']);
            if (empty($plan['zip'])) out_json(404, array('error' => 'This repo uses its own package_path'));
            out(200, 'application/zip', $plan['zip']);
        }
        if ($kind === 'raw') {
            $file = implode('/', array_slice($parts, 4));
            $body = raw_file($o, $r, $br['branch'], $file);
            $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
            $types = array('png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'svg' => 'image/svg+xml', 'webp' => 'image/webp');
            out(200, isset($types[$ext]) ? $types[$ext] : 'application/octet-stream', $body);
        }
    }
    out(404, 'text/plain', 'Not found');
} catch (Exception $e) {
    fail_msg($e->getMessage());
}
