// Headless behavioral checks for injected.js, run with an actual Chromium page (no CLI/recorder.js involved).
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');

async function main() {
  const launchOptions = {};
  if (process.env.WEBRECORDER_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.WEBRECORDER_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  const actions = [];

  await context.exposeBinding('__wrRecordAction', (_source, action) => {
    actions.push(action);
  });
  await context.exposeBinding('__wrControl', async () => {});
  await context.addInitScript({ path: path.join(__dirname, '..', 'src', 'injected.js') });

  const page = await context.newPage();
  // Use a real navigation (not page.setContent, which mutates the existing
  // document via document.open/write and never re-fires context init scripts).
  const html = '<html><body><input id="name-field" type="text" /><button id=":r1:">Submit</button></body></html>';
  await page.goto('data:text/html,' + encodeURIComponent(html));
  await page.waitForTimeout(150); // let the overlay panel mount

  // --- 12 keystrokes -> exactly one fill action ---
  await page.click('#name-field');
  await page.type('#name-field', 'abcdefghijkl', { delay: 5 });
  await page.click('body'); // blur, should flush the buffered fill
  await page.waitForTimeout(50);

  const fillActions = actions.filter((a) => a.type === 'fill');
  assert.strictEqual(fillActions.length, 1, `expected exactly 1 fill action, got ${fillActions.length}`);
  assert.strictEqual(fillActions[0].value, 'abcdefghijkl');
  console.log('ok - 12 keystrokes into a field produce exactly one fill action');

  // --- clicking the overlay panel records nothing ---
  const beforeCount = actions.length;
  await page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('*')).filter((el) => el.shadowRoot);
    const host = hosts[hosts.length - 1];
    const finishBtn = host.shadowRoot.getElementById('wr-finish');
    finishBtn.click();
  });
  await page.waitForTimeout(50);
  assert.strictEqual(actions.length, beforeCount, 'clicking the overlay panel must not record any action');
  console.log('ok - clicking the overlay panel records nothing');

  // --- generated-looking React id (:r1:) never produces a selector ---
  await page.getByText('Submit').click();
  await page.waitForTimeout(50);
  const clickActions = actions.filter((a) => a.type === 'click');
  const lastClick = clickActions[clickActions.length - 1];
  const cssCandidates = lastClick.selector.candidates.map((c) => c.css).filter(Boolean);
  const xpathCandidates = lastClick.selector.candidates.map((c) => c.xpath).filter(Boolean);
  for (const css of cssCandidates) {
    assert.ok(!css.includes('r1'), `css candidate must not reference generated id: ${css}`);
  }
  for (const xp of xpathCandidates) {
    assert.ok(!xp.includes('r1'), `xpath candidate must not reference generated id: ${xp}`);
  }
  assert.ok(
    !lastClick.selector.candidates.some((c) => c.engine === 'id'),
    'a generated-looking id must not even appear as an id candidate'
  );
  console.log('ok - a page with :r1:-style React ids does not produce #\\:r1\\: selectors');

  await browser.close();
  console.log('\nAll injected.js behavior tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
