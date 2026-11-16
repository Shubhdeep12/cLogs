'use strict';
/**
 * Self-test used by `npm run smoke`: drives the real window through recording,
 * a captured session and every detail tab, then a HAR export → import round
 * trip. Saves screenshots + report.json. Only loaded when NETLOG_SMOKE_OUT is set
 * (NETLOG_SMOKE_SINCE backdates the recording so existing activity is captured).
 */
const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function runSmoke(app, outDir, hooks) {
  fs.mkdirSync(outDir, { recursive: true });
  const problems = [];
  const report = { problems };
  const finish = () => {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    app.quit();
  };
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('console-message', (...args) => {
      const d = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
      if (d.level === 'error' || d.level === 3) problems.push(`console: ${d.message}`);
    });
    win.webContents.on('render-process-gone', (_e2, det) => problems.push(`renderer gone: ${det.reason}`));
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const shot = async (name) => fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      const clickTab = (name) => js(`(() => { const t = [...document.querySelectorAll('.tab')].find((x) => x.textContent === ${JSON.stringify(name)}); t && t.click(); return !!t; })()`);
      try {
        await wait(4000);
        report.recStatus = await js('document.querySelector("#rec-status").innerText');
        report.recordedSessions = await js('document.querySelectorAll(".sess").length');
        report.accountState = await js(`({ account: S.account, chips: [...document.querySelectorAll("#account-filter .chip")].map((c) => c.className + " " + c.textContent) })`);
        await shot('01-recording');
        const want = process.env.NETLOG_SMOKE_SESSION || '';
        report.opened = await js(`(() => {
          const all = [...document.querySelectorAll('.sess')];
          const b = all.find((x) => x.title.includes(${JSON.stringify(want)})) || all[0];
          if (!b) return null; b.click(); return b.title.split('\\n')[0];
        })()`);
        await wait(2000);
        report.rows = await js('document.querySelectorAll("#calls tbody tr").length');
        report.kinds = await js('[...document.querySelectorAll("#calls tbody .kind")].reduce((a, e) => (a[e.textContent] = (a[e.textContent] || 0) + 1, a), {})');
        await js(`(() => { const r = [...document.querySelectorAll('#calls tbody tr')].filter((t) => t.querySelector('.k-api')); (r[Math.floor(r.length / 2)] || r[0]).click(); })()`);
        await wait(700);
        for (const t of ['Headers', 'Payload', 'Preview', 'Response', 'Usage', 'Timing']) {
          await clickTab(t); await wait(300); await shot(`02-api-${t.toLowerCase()}`);
        }
        await clickTab('Payload'); await wait(200);
        report.payloadHead = (await js('document.querySelector(".d-body").innerText')).split('\n').slice(0, 2).join(' | ');

        // HAR round trip
        const key = await js('S.key');
        const harFile = path.join(outDir, 'session.har');
        report.exported = hooks.writeHar(key, harFile);
        const har = JSON.parse(fs.readFileSync(harFile, 'utf8'));
        const bad = har.log.entries.filter((e) => !e.startedDateTime || !e.request || !e.request.url || !e.response || typeof e.response.status !== 'number' || !e.timings);
        report.harInvalidEntries = bad.length;
        report.harWithBodies = har.log.entries.filter((e) => e.request.postData).length;
        hooks.importHarFile(harFile);
        await js('netlog.state().then(applyState)');
        await wait(500);
        report.importedRows = await js(`(async () => {
          const b = [...document.querySelectorAll('.sess')].pop(); b.click();
          await new Promise((r) => setTimeout(r, 1200));
          return document.querySelectorAll('#calls tbody tr').length;
        })()`);
        await js(`(() => { const r = [...document.querySelectorAll('#calls tbody tr')].filter((t) => t.querySelector('.k-api')); (r[Math.floor(r.length / 2)] || r[0]).click(); })()`);
        await wait(700);
        await clickTab('Preview'); await wait(300);
        await shot('03-imported-preview');
        await clickTab('Payload'); await wait(200);
        report.importedPayloadHead = (await js('document.querySelector(".d-body").innerText')).split('\n').slice(0, 2).join(' | ');

        // stop + clear
        await js('document.querySelector("#btn-rec").click()');
        await wait(800);
        report.afterStop = await js('document.querySelector("#rec-status").innerText');
        await js('document.querySelector("#btn-clear").click()');
        await wait(800);
        report.afterClear = await js('document.querySelector("#rec-status").innerText');
        report.sessionsAfterClear = await js('document.querySelectorAll(".sess").length');
        await shot('04-after-clear');
      } catch (e) {
        problems.push(`smoke failed: ${e.stack}`);
      }
      finish();
    });
  });
};
