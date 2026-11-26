'use strict';
/**
 * In-app updates from GitHub Releases, without Apple's updater.
 *
 * electron-updater on macOS goes through Squirrel.Mac, which only accepts apps
 * signed with a Developer ID. cLogs builds are ad-hoc signed, so instead:
 *
 *   check    GET the latest release from the GitHub API (no data about the
 *            user's sessions is sent; it's a plain anonymous request).
 *   download the asset for this platform, then verify its SHA-256 against the
 *            release's SHA256SUMS.txt.
 *   install  macOS: unzip, check the signature, and swap the .app bundle in
 *            place after the app quits, then relaunch.
 *            Windows (installed): run the NSIS installer silently, relaunch.
 *            Linux AppImage: replace the AppImage file, relaunch.
 *   other    portable .exe, .tar.gz, running from the DMG or from source:
 *            open the release page instead.
 *
 * Files fetched by the app itself carry no quarantine flag, so the swapped-in
 * app opens without another Gatekeeper prompt.
 */
const { app, net, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'Shubhdeep12/cLogs';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'cLogs-updater' };

/** "v1.2.3" / "1.2.3" → [1, 2, 3]; anything else → null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** >0 if a is newer than b, <0 if older, 0 if equal or unparseable. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** SHA256SUMS.txt ("<hex>  <name>" per line) → Map(name → hex). */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/** The release asset that updates this install, by platform and arch. */
function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const re = platform === 'darwin' ? new RegExp(`-mac-${arch}\\.zip$`, 'i')
    : platform === 'win32' ? /-win-.*setup\.exe$/i
      : platform === 'linux' ? /-linux-.*\.AppImage$/i
        : null;
  return (re && (assets || []).find((a) => re.test(a.name))) || null;
}

function writable(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}

/** How this copy of the app can update itself, or null to fall back to the release page. */
function installMode() {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') {
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    // Running from the DMG, or translocated by Gatekeeper (read-only, random path): can't swap.
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return null;
    return writable(path.dirname(bundle)) && writable(bundle) ? { kind: 'mac', bundle } : null;
  }
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_DIR ? null : { kind: 'win' };
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    const file = process.env.APPIMAGE;
    return writable(path.dirname(file)) ? { kind: 'appimage', file } : null;
  }
  return null;
}

async function getJSON(url) {
  const r = await net.fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, cache: 'no-store' });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return r.text();
}

async function download(url, dest, onProgress) {
  const r = await net.fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, cache: 'no-store' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of r.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (total) onProgress(got / total);
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  return hash.digest('hex');
}

// Waits for the old app to exit, swaps the bundle (restoring it if the move fails), relaunches.
const MAC_SWAP = [
  'pid="$1"; old="$2"; new="$3"',
  'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
  'rm -rf "$old.previous"',
  'if mv "$old" "$old.previous" && mv "$new" "$old"; then rm -rf "$old.previous"; else [ -d "$old" ] || mv "$old.previous" "$old"; fi',
  'open "$old"',
].join('\n');

class Updater {
  /** @param {{ onChange: (state: object) => void, isEnabled: () => boolean }} opts */
  constructor({ onChange, isEnabled }) {
    this.onChange = onChange;
    this.isEnabled = isEnabled;
    this.release = null;
    this.timer = null;
    this.state = { status: 'idle', current: app.getVersion() };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Check now and every few hours after, while automatic checks are on. */
  schedule(firstDelayMs = 5000, everyMs = 6 * 3600 * 1000) {
    clearTimeout(this.timer);
    const run = async () => {
      if (this.isEnabled()) await this.check().catch(() => {});
      this.timer = setTimeout(run, everyMs);
    };
    this.timer = setTimeout(run, firstDelayMs);
  }

  /** @returns {Promise<object>} the new state */
  async check() {
    if (['downloading', 'installing'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null });
    try {
      const rel = await getJSON(API);
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      if (compareVersions(latest, app.getVersion()) <= 0) {
        this.release = null;
        this.set({ status: 'current', latest });
        return this.state;
      }
      this.release = rel;
      const mode = installMode();
      const asset = mode && pickAsset(rel.assets);
      const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
      this.set({ status: 'available', latest, url: rel.html_url, canInstall: Boolean(asset && sums), progress: 0 });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.state;
  }

  /** Download, verify and install the available update, or open its page when that isn't possible here. */
  async install() {
    const rel = this.release;
    if (!rel || this.state.status !== 'available') return;
    if (!this.state.canInstall) { shell.openExternal(rel.html_url); return; }
    const mode = installMode();
    const asset = pickAsset(rel.assets);
    const sumsAsset = rel.assets.find((a) => a.name === 'SHA256SUMS.txt');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clogs-update-'));
    try {
      this.set({ status: 'downloading', progress: 0, error: null });
      const sums = parseSums(await getText(sumsAsset.browser_download_url));
      const expected = sums.get(asset.name);
      if (!expected) throw new Error(`${asset.name} is missing from SHA256SUMS.txt`);
      const file = path.join(dir, asset.name);
      let last = 0;
      const actual = await download(asset.browser_download_url, file, (p) => {
        if (p - last >= 0.02 || p === 1) { last = p; this.set({ progress: p }); }
      });
      if (actual !== expected) throw new Error('Checksum mismatch: the download was not installed');

      this.set({ status: 'installing', progress: 1 });
      if (mode.kind === 'mac') this.installMac(mode.bundle, file, dir);
      else if (mode.kind === 'win') this.installWin(file);
      else if (mode.kind === 'appimage') this.installAppImage(mode.file, file);
      setTimeout(() => app.quit(), 300);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      this.set({ status: 'available', error: e.message });
    }
  }

  installMac(bundle, zip, dir) {
    const unpacked = path.join(dir, 'unpacked');
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    const name = fs.readdirSync(unpacked).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('The update archive has no app inside');
    const next = path.join(unpacked, name);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
    try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]); } catch { /* not set */ }
    spawn('/bin/sh', ['-c', MAC_SWAP, 'clogs-update', String(process.pid), bundle, next], { detached: true, stdio: 'ignore' }).unref();
  }

  installWin(setup) {
    // electron-builder NSIS: /S installs silently over the current install, --force-run relaunches it.
    spawn(setup, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  }

  installAppImage(target, file) {
    const staged = `${target}.update`;
    fs.copyFileSync(file, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, target); // atomic; the running copy keeps its open inode
    const env = { ...process.env };
    delete env.APPIMAGE; // the AppImage runtime sets it again for the new process
    spawn(target, [], { detached: true, stdio: 'ignore', env }).unref();
  }
}

module.exports = { Updater, compareVersions, parseVersion, parseSums, pickAsset };
