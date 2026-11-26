'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, parseSums, pickAsset } = require('../src/updater');

test('compares release versions numerically', () => {
  assert.ok(compareVersions('v0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('0.2.0', 'v0.10.0') < 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('nightly', '1.0.0'), 0); // unparseable never counts as newer
});

test('parses SHA256SUMS.txt', () => {
  const hex = 'a'.repeat(64);
  const sums = parseSums(`${hex}  clogs-0.2.0-mac-arm64.zip\n${'b'.repeat(64)} *clogs-0.2.0-win-x64-setup.exe\n\njunk line\n`);
  assert.equal(sums.get('clogs-0.2.0-mac-arm64.zip'), hex);
  assert.equal(sums.get('clogs-0.2.0-win-x64-setup.exe'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('picks the asset that updates this install', () => {
  const assets = [
    'clogs-0.2.0-linux-x64.tar.gz', 'clogs-0.2.0-linux-x86_64.AppImage',
    'clogs-0.2.0-mac-arm64.dmg', 'clogs-0.2.0-mac-arm64.zip', 'clogs-0.2.0-mac-x64.dmg', 'clogs-0.2.0-mac-x64.zip',
    'clogs-0.2.0-win-x64-portable.exe', 'clogs-0.2.0-win-x64-setup.exe', 'SHA256SUMS.txt',
  ].map((name) => ({ name }));
  assert.equal(pickAsset(assets, 'darwin', 'arm64').name, 'clogs-0.2.0-mac-arm64.zip');
  assert.equal(pickAsset(assets, 'darwin', 'x64').name, 'clogs-0.2.0-mac-x64.zip');
  assert.equal(pickAsset(assets, 'win32', 'x64').name, 'clogs-0.2.0-win-x64-setup.exe');
  assert.equal(pickAsset(assets, 'linux', 'x64').name, 'clogs-0.2.0-linux-x86_64.AppImage');
  assert.equal(pickAsset(assets, 'freebsd', 'x64'), null);
});
