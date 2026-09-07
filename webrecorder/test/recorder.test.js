// End-to-end checks for the REAL recorder.js record() (via its `drive` hook):
// navigation detection, download ordering/flushing, and output handling.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { record } = require('../src/recorder');
const { serveDir, check } = require('./helpers');

const NAV_SITE = path.join(__dirname, 'fixtures', 'nav-site');
const DOWNLOADS_SITE = path.join(__dirname, 'fixtures', 'downloads-site');

async function recordWith(startUrl, out, drive) {
  await record({ url: startUrl, out, headless: true, drive });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webrecorder-test-'));
  const nav = await serveDir(NAV_SITE);
  const dl = await serveDir(DOWNLOADS_SITE);

  let session;
  await check('record(): creates a missing output directory instead of losing the session at the end', async () => {
    const out = path.join(tmp, 'nested', 'deeper', 'session.json');
    session = await recordWith(`${nav.baseUrl}/redirect.html`, out, async (page) => {
      await page.waitForURL(/index\.html$/);
      await page.click('#plain-btn');
      await page.waitForURL(/other\.html$/);
      await page.click('#back');
      await page.waitForURL(/index\.html$/);
      await page.selectOption('#jump', '/other.html');
      await page.waitForURL(/other\.html$/);
      await page.click('#back');
      await page.waitForURL(/index\.html$/);
      await page.click('#spa-btn');
      await page.waitForTimeout(100);
    });
    assert.ok(fs.existsSync(out));
    assert.strictEqual(session.startUrl, `${nav.baseUrl}/redirect.html`);
  });

  const navs = () => session.actions.filter((a) => a.type === 'navigate');
  await check('record(): the start URL redirect is not recorded as a step (goto(startUrl) reproduces it)', async () => {
    assert.ok(!navs().some((n) => n.url.endsWith('/index.html') && session.actions.indexOf(n) === 0));
    assert.notStrictEqual(session.actions[0].type, 'navigate');
  });
  await check('record(): a plain <button onclick> navigation is an implicit navigate', async () => {
    const n = navs()[0];
    assert.ok(n.url.endsWith('/other.html'));
    assert.strictEqual(n.implicit, true);
    assert.strictEqual(session.actions[session.actions.indexOf(n) - 1].type, 'click');
  });
  await check('record(): a <select> jump-menu navigation counts as implicit too', async () => {
    const idx = session.actions.findIndex((a) => a.type === 'selectOption');
    assert.ok(idx > 0);
    const after = session.actions[idx + 1];
    assert.strictEqual(after.type, 'navigate');
    assert.strictEqual(after.implicit, true);
    assert.ok(after.url.endsWith('/other.html'));
  });
  await check('record(): a pushState route change is an implicit navigate', async () => {
    const last = navs().pop();
    assert.ok(last.url.endsWith('/spa-other'), last.url);
    assert.strictEqual(last.implicit, true);
  });

  await check('record(): download actions keep their place after the triggering click and are fully parsed even when finishing immediately', async () => {
    const out = path.join(tmp, 'dl', 'session.json');
    const s = await recordWith(`${dl.baseUrl}/downloads.html`, out, async (page) => {
      await page.click('#download-csv');
      await page.click('#download-xlsx'); // immediately — no waiting for the first download to finish
      // drive returns right away: finishRecording must wait for both downloads to be saved + parsed
    });
    const t = s.actions.map((a) => a.type);
    assert.deepStrictEqual(t, ['click', 'download', 'click', 'download'], `order was ${t}`);
    for (const d of s.actions.filter((a) => a.type === 'download')) {
      assert.deepStrictEqual(d.headers, ['AWB', 'Status', 'Weight'], JSON.stringify(d));
      assert.strictEqual(d.rows.length, 2);
      assert.ok(d.savedPath && fs.existsSync(path.join(path.dirname(out), d.savedPath)), `missing ${d.savedPath}`);
    }
    assert.strictEqual(s.actions[1].suggestedFilename, 'shipments-report.csv');
    assert.strictEqual(s.actions[3].suggestedFilename, 'shipments-report.xlsx');
  });

  nav.server.close();
  dl.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nAll recorder tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
