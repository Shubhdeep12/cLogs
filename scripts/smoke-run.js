#!/usr/bin/env node
'use strict';
// Launches the app in self-test mode; screenshots + report.json land in the given folder.
//   npm run smoke -- <outDir> [session-title-substring] [hours-back=3]
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'smoke-output'));
const r = spawnSync(electron, [path.join(__dirname, '..')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NETLOG_SMOKE_OUT: out,
    NETLOG_SMOKE_SESSION: process.argv[3] || '',
    NETLOG_SMOKE_SINCE: String(Date.now() - Number(process.argv[4] || 3) * 3600 * 1000),
  },
  timeout: 90000,
});
console.log(`smoke output: ${out}`);
process.exit(r.status ?? 1);
