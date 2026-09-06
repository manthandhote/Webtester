const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const IMPLICIT_NAV_WINDOW_MS = 3000;

async function record({ url, out, headless = false }) {
  if (!url) throw new Error('record() requires a url');
  if (!out) throw new Error('record() requires an out path');

  const launchOptions = { headless };
  if (process.env.WEBRECORDER_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.WEBRECORDER_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();

  const actions = [];
  let lastInteractionTime = 0;
  let sawFirstPage = false;
  let finished = false;

  await context.exposeBinding('__wrRecordAction', (_source, action) => {
    actions.push(action);
    if (action.type === 'click' || action.type === 'press') {
      lastInteractionTime = Date.now();
    }
  });

  await context.exposeBinding('__wrControl', async (_source, command) => {
    if (command === 'finish') {
      await finishRecording();
    }
  });

  await context.addInitScript({ path: path.join(__dirname, 'injected.js') });

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
  await page.goto(url);

  function writeSession() {
    const session = {
      startUrl: url,
      recordedAt: new Date().toISOString(),
      actions,
    };
    fs.writeFileSync(out, JSON.stringify(session, null, 2));
    console.log(`\nSaved ${actions.length} action(s) to ${out}`);
  }

  async function finishRecording() {
    if (finished) return;
    finished = true;
    writeSession();
    await browser.close().catch(() => {});
  }

  process.on('SIGINT', () => {
    finishRecording().then(() => process.exit(0));
  });

  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
  });
  if (!finished) {
    finished = true;
    writeSession();
  }
}

module.exports = { record };
