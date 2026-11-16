#!/usr/bin/env node
'use strict';
/**
 * Renders build/icon.svg to build/icon.png (1024×1024) using Electron's own
 * Chromium, so no image tooling is needed. electron-builder derives the
 * macOS .icns, Windows .ico and Linux icon sizes from icon.png.
 *   npm run icon                      (build/icon.svg → build/icon.png)
 *   node scripts/render-icon.js in.svg out.png [size]
 */
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const args = process.argv.slice(process.argv.indexOf(__filename) + 1);
const input = path.resolve(args[0] || path.join(root, 'build', 'icon.svg'));
const output = path.resolve(args[1] || path.join(root, 'build', 'icon.png'));
const SIZE = Number(args[2]) || 1024;
const svg = fs.readFileSync(input, 'utf8').replace(/<svg([^>]*)\swidth="\d+"\s+height="\d+"/, `<svg$1 width="${SIZE}" height="${SIZE}"`);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = img.getSize().width === SIZE ? img : img.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.writeFileSync(output, out.toPNG());
  console.log('wrote', path.relative(process.cwd(), output), out.getSize());
  app.quit();
});
