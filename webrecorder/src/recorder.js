const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { parseCsvRows, cellToString } = require('./tabular');

const IMPLICIT_NAV_WINDOW_MS = 3000;
// Actions that count as "the user did something" for implicit-navigation
// detection. A <select> jump-menu or a radio that submits its form navigates
// just as much as a click does.
const INTERACTION_TYPES = new Set(['click', 'press', 'check', 'uncheck', 'selectOption']);
// Binding calls from the page are async; give the last in-flight ones (e.g.
// the fill flushed by the blur that clicking Finish causes) time to land.
const SETTLE_MS = 150;
const PENDING_DOWNLOAD_TIMEOUT_MS = 10000;

async function parseXlsxFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], rows: [] };
  const grid = [];
  worksheet.eachRow((row) => {
    grid.push(row.values.slice(1).map(cellToString));
  });
  return { headers: grid[0] || [], rows: grid.slice(1) };
}

async function parseTabularFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    const grid = parseCsvRows(fs.readFileSync(filePath, 'utf8'));
    return { headers: grid[0] || [], rows: grid.slice(1) };
  }
  if (ext === '.xlsx' || ext === '.xls') {
    return parseXlsxFile(filePath);
  }
  return null;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms).unref())]);
}

// `drive`, when given, is called with the page after the initial navigation;
// recording finishes as soon as it resolves. Lets scripted/CI recordings (and
// the tests) run the real recorder without a human at the keyboard.
async function record({ url, out, headless = false, drive = null }) {
  if (!url) throw new Error('record() requires a url');
  if (!out) throw new Error('record() requires an out path');

  // Fail fast: discovering the output directory doesn't exist only when
  // writing at the end would throw away the entire recording.
  const outPath = path.resolve(out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const downloadsDir = path.join(path.dirname(outPath), 'downloads');

  const launchOptions = { headless };
  if (process.env.WEBRECORDER_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.WEBRECORDER_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ acceptDownloads: true });

  const actions = [];
  const pendingDownloads = new Set();
  let lastInteractionTime = 0;
  let initialNavigationSettled = false;
  let finished = false;

  await context.exposeBinding('__wrRecordAction', (_source, action) => {
    actions.push(action);
    if (INTERACTION_TYPES.has(action.type)) {
      lastInteractionTime = Date.now();
    }
  });

  await context.exposeBinding('__wrControl', (_source, command) => {
    // Don't close the browser from inside a binding call: the page is torn
    // down before the call can be answered, which surfaces as an error.
    if (command === 'finish') setTimeout(finishRecording, 0);
  });

  await context.addInitScript({ path: path.join(__dirname, 'injected.js') });

  function attachNavListener(page) {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const navUrl = frame.url();
      if (navUrl === 'about:blank') return;
      // Everything up to and including the initial goto (redirects included)
      // is reproduced by the generated test's own goto(startUrl).
      if (!initialNavigationSettled) return;
      const now = Date.now();
      const implicit = now - lastInteractionTime <= IMPLICIT_NAV_WINDOW_MS;
      actions.push({ type: 'navigate', url: navUrl, implicit, timestamp: now });
    });
  }

  function attachDownloadListener(page) {
    page.on('download', (download) => {
      const suggested = path.basename(download.suggestedFilename());
      // Push now so the action keeps its place right after the click that
      // triggered it; saving + parsing fill in the details asynchronously.
      const action = {
        type: 'download',
        suggestedFilename: suggested,
        savedPath: null,
        headers: null,
        rows: null,
        timestamp: Date.now(),
      };
      actions.push(action);

      const task = (async () => {
        fs.mkdirSync(downloadsDir, { recursive: true });
        const savedPath = path.join(downloadsDir, `${Date.now()}-${suggested}`);
        await download.saveAs(savedPath);
        action.savedPath = path.relative(path.dirname(outPath), savedPath);
        const parsed = await parseTabularFile(savedPath);
        if (parsed) {
          action.headers = parsed.headers;
          action.rows = parsed.rows;
        }
      })().catch((err) => {
        console.error(`Failed to capture download "${suggested}": ${err.message}`);
      });
      pendingDownloads.add(task);
      task.finally(() => pendingDownloads.delete(task));
    });
  }

  context.on('page', (page) => {
    attachNavListener(page);
    attachDownloadListener(page);
  });

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.error(`Warning: initial navigation to ${url} did not complete cleanly (${err.message}); recording anyway.`);
  }
  initialNavigationSettled = true;

  async function writeSession() {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (pendingDownloads.size) {
      await withTimeout(Promise.all(pendingDownloads), PENDING_DOWNLOAD_TIMEOUT_MS);
    }
    const session = { startUrl: url, recordedAt: new Date().toISOString(), actions };
    fs.writeFileSync(outPath, JSON.stringify(session, null, 2));
    console.log(`\nSaved ${actions.length} action(s) to ${out}`);
  }

  async function finishRecording() {
    if (finished) return;
    finished = true;
    try {
      await writeSession();
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const onSigint = () => {
    // If the browser refuses to close, still exit; the session is already on disk.
    setTimeout(() => process.exit(0), 5000).unref();
    finishRecording().then(() => process.exit(0));
  };
  process.on('SIGINT', onSigint);

  try {
    if (drive) {
      await drive(page);
      await finishRecording();
    } else {
      await new Promise((resolve) => browser.on('disconnected', resolve));
    }
    if (!finished) {
      finished = true;
      await writeSession();
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

module.exports = { record, parseTabularFile };
