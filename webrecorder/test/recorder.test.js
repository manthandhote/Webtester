// Proves navigate detection is generic: it fires on ANY click that's followed by a
// navigation within the 3s window, not just clicks on <a> links / navbar items.
// Duplicates recorder.js's context-wiring (same exposeBinding/addInitScript pattern,
// same attachNavListener logic) so this can drive pages programmatically instead of
// going through the CLI's full launch/write-file/process lifecycle.
const http = require('http');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const IMPLICIT_NAV_WINDOW_MS = 3000;

const PAGES = {
  '/index.html': `<html><body>
    <button id="plain-btn" onclick="location.href='/other.html'">Not a link, just a button</button>
  </body></html>`,
  '/spa.html': `<html><body>
    <button id="spa-btn" onclick="history.pushState({}, '', '/spa-other')">Client-side route change</button>
  </body></html>`,
  '/other.html': `<html><body>Other page</body></html>`,
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = PAGES[req.url];
      if (!body) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;

  const launchOptions = {};
  if (process.env.WEBRECORDER_CHROMIUM_PATH) launchOptions.executablePath = process.env.WEBRECORDER_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();

  const actions = [];
  let lastInteractionTime = 0;
  let sawFirstPage = false;

  await context.exposeBinding('__wrRecordAction', (_s, action) => {
    actions.push(action);
    if (action.type === 'click' || action.type === 'press') lastInteractionTime = Date.now();
  });
  await context.exposeBinding('__wrControl', async () => {});
  await context.addInitScript({ path: path.join(__dirname, '..', 'src', 'injected.js') });

  function attachNavListener(page, isPrimary) {
    let skippedInitial = !isPrimary;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const navUrl = frame.url();
      if (navUrl === 'about:blank') return;
      if (!skippedInitial) {
        skippedInitial = true;
        return;
      }
      const now = Date.now();
      const implicit = now - lastInteractionTime <= IMPLICIT_NAV_WINDOW_MS;
      actions.push({ type: 'navigate', url: navUrl, implicit, timestamp: now });
    });
  }
  context.on('page', (page) => {
    const isPrimary = !sawFirstPage;
    sawFirstPage = true;
    attachNavListener(page, isPrimary);
  });

  const page = await context.newPage();

  // --- a plain <button onclick> full navigation, not an <a> link ---
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForTimeout(150);
  await page.click('#plain-btn');
  await page.waitForLoadState('load');
  await page.waitForTimeout(100);

  const navAfterButton = actions.filter((a) => a.type === 'navigate').pop();
  assert.ok(navAfterButton, 'expected a navigate action after clicking the plain button');
  assert.strictEqual(navAfterButton.implicit, true);
  assert.ok(navAfterButton.url.endsWith('/other.html'), `expected navigation to /other.html, got ${navAfterButton.url}`);
  console.log('ok - clicking a plain <button> (not a link) that navigates is detected as an implicit navigate');

  // --- a client-side route change (history.pushState), no full page reload ---
  actions.length = 0;
  await page.goto(`http://127.0.0.1:${port}/spa.html`);
  await page.waitForTimeout(150);
  await page.click('#spa-btn');
  await page.waitForTimeout(100);

  const navAfterSpa = actions.filter((a) => a.type === 'navigate').pop();
  assert.ok(navAfterSpa, 'expected a navigate action after a pushState route change');
  assert.strictEqual(navAfterSpa.implicit, true);
  assert.ok(navAfterSpa.url.endsWith('/spa-other'), `expected navigation to /spa-other, got ${navAfterSpa.url}`);
  console.log('ok - a button-triggered client-side route change (pushState) is also detected as an implicit navigate');

  await browser.close();
  server.close();
  console.log('\nAll recorder navigate-detection tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
