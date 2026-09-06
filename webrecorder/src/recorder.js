const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');

const IMPLICIT_NAV_WINDOW_MS = 3000;

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c === '\r') {
      // ignore; \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

function cellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return String(v.result);
    if ('text' in v) return String(v.text);
    return JSON.stringify(v);
  }
  return String(v);
}

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

async function record({ url, out, headless = false }) {
  if (!url) throw new Error('record() requires a url');
  if (!out) throw new Error('record() requires an out path');

  const launchOptions = { headless };
  if (process.env.WEBRECORDER_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.WEBRECORDER_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ acceptDownloads: true });

  const actions = [];
  let lastInteractionTime = 0;
  let sawFirstPage = false;
  let finished = false;
  const downloadsDir = path.join(path.dirname(path.resolve(out)), 'downloads');

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

  function attachDownloadListener(page) {
    page.on('download', async (download) => {
      try {
        const suggested = download.suggestedFilename();
        fs.mkdirSync(downloadsDir, { recursive: true });
        const savedPath = path.join(downloadsDir, `${Date.now()}-${suggested}`);
        await download.saveAs(savedPath);
        const parsed = await parseTabularFile(savedPath);
        actions.push({
          type: 'download',
          suggestedFilename: suggested,
          savedPath: path.relative(path.dirname(path.resolve(out)), savedPath),
          headers: parsed ? parsed.headers : null,
          rows: parsed ? parsed.rows : null,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`Failed to capture download: ${err.message}`);
      }
    });
  }

  context.on('page', (page) => {
    const isPrimary = !sawFirstPage;
    sawFirstPage = true;
    attachNavListener(page, isPrimary);
    attachDownloadListener(page);
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

module.exports = { record, parseTabularFile, parseCsvRows };
