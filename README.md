# Ferraris – GitHub app store for Firefox OS

Ferraris lets you type `user/repository` on an old Firefox OS phone and install the app from that
GitHub repository.

## Why a PC is needed (the "Network error" you got before)

GitHub only accepts modern https (TLS 1.2+). Firefox OS from 2013 cannot open https://github.com,
https://api.github.com or https://raw.githubusercontent.com at all, so Ferraris used to fail with
*"No manifest.webapp found - Network error"*.

Now `install-server.js` on your computer acts as a **GitHub helper**: Ferraris asks the PC, the PC talks
to GitHub, and the phone only ever speaks plain `http` to the PC. The PC also builds the app package
from the repo and serves it with the MIME type Firefox OS demands
(`application/x-web-app-manifest+json`). **Keep the server running whenever you add or install apps.**

## Two ways to run the helper

| | Where it runs | Needs |
|---|---|---|
| **A. PC** (`install-server.js`) | your computer, only while it is on | Node.js 14+ |
| **B. Web host** (`host-php/`) | any PHP web host that serves plain `http://`, always on, works everywhere | PHP 7+ with curl + zip, a host that allows outgoing connections |

Both have exactly the same features. Option B is the "Cydia way": no PC needed after the setup.
Option B instructions are in the section **"Option B: always-on web host"** further down. The steps
right below describe option A.

## Step by step (option A: PC)

### 0. What you need
- A computer with [Node.js](https://nodejs.org) 14 or newer (no npm packages needed).
- The computer and the phone on the **same Wi-Fi** (see "Hotspot trick" if the router blocks it).

### 1. Start the server on the computer
```
cd ferraris
node install-server.js
```
It prints one or more addresses like `http://192.168.1.23:8080/`. Leave the window open.
(`PORT=9000 node install-server.js` changes the port; `--once` makes it quit after Ferraris is installed.)

### 2. Test the connection (recommended)
In the phone's **Browser** app open `http://<that address>/test`. You want:
- `[ OK ] 1. This PC` – phone and PC see each other.
- `[ OK ] 2. Via the PC to GitHub` – the PC can reach GitHub.
- Line 3 (phone directly to GitHub) will probably say FAIL. That is normal on old Firefox OS.

### 3. Install Ferraris
1. Open `http://<that address>/` in the phone **Browser** app (not in another app, not https).
2. Tap the red **JAILBREAK** button and confirm the install prompt.
3. If an older Ferraris is already installed, delete it first (hold its icon on the home screen → remove),
   otherwise the phone refuses the new one.

### 4. Add and install an app
1. Open **Ferraris**. At the bottom the "PC helper" box is already filled with your PC's address.
   If your PC's IP changes later, type the new address there and tap **Save**
   (it says "PC helper reachable" when it works).
2. Type `xgbzdev/test-app-firefoxos` (or a full github.com URL) and tap **Add**.
   The first time it can take several seconds: the PC downloads the repo.
3. Tap **Install** and confirm. Tap **Open** to launch it.

Fallback: if Install inside Ferraris fails, open `http://<pc address>/i/user/repository`
in the phone's Browser and tap INSTALL there.

## Option B: always-on web host (no PC needed)

1. Get PHP web hosting where **`http://` works without being forced to `https://`**. Many free hosts redirect
   to https, which your phone cannot follow. Test before investing time: upload any file and open it from
   the phone's Browser with `http://`.
2. Upload the **contents** of the `host-php/` folder (`index.php`, `.htaccess`, `app/`) to the host
   (FTP or the file manager), either to the site root or to a subfolder such as `ferraris/`.
3. On the phone's Browser open `http://YOUR-HOST/` (or `http://YOUR-HOST/ferraris/`) and then `.../test`.
   - Line 1 OK = the host works over http.
   - Line 2 OK = the host can reach GitHub. If it says *"Cannot reach GitHub from this web host"*, the host blocks
     outgoing connections (common on free plans): use another host.
4. Open `http://YOUR-HOST/`, tap **JAILBREAK**. Ferraris is installed already pointing to your host.
   Add `user/repo` and install apps from anywhere, with the PC off.

Notes:
- If clean URLs do not work (your host ignores `.htaccess`), use `http://YOUR-HOST/index.php` as the address
  everywhere (it also works as the helper address in Ferraris: `http://YOUR-HOST/index.php`).
- Optional: put a GitHub token in `index.php` (`github_token`) to lift the 60 requests/hour limit.
- `host-php/app` is a copy of `app/`. If you change the Ferraris app, copy it there again.
- Anyone who knows the address can use your host as a GitHub proxy (only github.com hosts are allowed).
  Keep the address to yourself or add HTTP auth in the host's panel *only if* it is excluded for the phone
  (old Firefox OS cannot always send credentials).

## What a repository needs
Public repo with a `manifest.webapp` (any folder). The PC decides automatically:
1. If a manifest has a **real** `package_path` (a working https zip URL), that zip is used.
   (Placeholders like `YOUR_GITHUB_USERNAME` are ignored.)
2. Otherwise the folder that contains the app's `manifest.webapp` (the one with `launch_path`) is zipped
   and installed as a packaged app. No GitHub Pages, no zip to maintain.

Limits: 1000 files, 30 MB total, 5 MB per file. After you push changes to the repo, Remove + Add + Install
again in Ferraris (the PC caches a repo for 10 minutes). GitHub allows 60 anonymous API calls per hour;
start the server with `GITHUB_TOKEN=<a personal access token>` if you hit the limit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone browser cannot open the page / nothing is logged in the PC window | Different Wi-Fi, or the PC firewall blocks Node. Windows: allow Node.js on Private networks (or run `netsh advfirewall firewall add rule name=Ferraris dir=in action=allow protocol=TCP localport=8080`). macOS: allow incoming connections for node. Use the exact IP printed by the server, with `http://`. |
| Router "AP / client isolation" or guest Wi-Fi | Use the hotspot trick below. |
| "Cannot reach the PC" in Ferraris | Server not running, PC address changed, or phone on mobile data. Fix the address in the PC helper box. |
| `No manifest.webapp found in this repository` | The repo is private, the name is misspelled, or there is no file called exactly `manifest.webapp`. |
| `GitHub API rate limit reached` | Wait an hour or use `GITHUB_TOKEN`. |
| Install fails with `DENIED` | You tapped Cancel, or the app is already installed: remove the old copy first. |
| Install fails with another error | Keep the server window visible: it logs every request. If the phone never requests `/gh/pkg/...`, the phone refused the mini-manifest. |
| Port 8080 in use | `PORT=9000 node install-server.js`. |

**Hotspot trick:** turn on a Wi-Fi hotspot on the PC (or phone) and connect the other device to it. That
removes router isolation problems.

## Files
- `install-server.js` – option A: installer page, `/test` page and GitHub helper (`/gh/...`), no dependencies.
- `host-php/` – option B: the same thing as a PHP site for a web host.
- `app/` – the Ferraris app itself (plain ES5 so it runs on Gecko 18+).
