'use strict';
/**
 * electron-builder afterPack hook: ad-hoc sign the macOS app bundle.
 *
 * Without a Developer ID, electron-builder skips signing and the bundle keeps
 * only the linker signature on the main binary. That signature doesn't cover
 * the bundle's resources, so a downloaded (quarantined) copy fails Gatekeeper
 * with "cLogs is damaged and can't be opened", which has no override.
 *
 * An ad-hoc signature over the whole bundle is valid, so macOS shows the usual
 * "unidentified developer" prompt instead, which users can get past with
 * right-click → Open (or Privacy & Security → Open Anyway on macOS 15+).
 *
 * When a real signing identity is configured, electron-builder signs after
 * this hook and replaces the ad-hoc signature.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${path.basename(app)}`);
};
