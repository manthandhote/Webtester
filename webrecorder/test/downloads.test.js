// Real end-to-end check for the download+report-verification feature: an actual
// browser download (CSV and XLSX) captured via a real page.on('download'), parsed
// with recorder.js's real parseTabularFile, then generated into a Playwright spec.
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { chromium } = require('playwright');
const { parseTabularFile } = require('../src/recorder');
const generators = require('../src/generators');

const SITE_DIR = path.join(__dirname, 'fixtures', 'downloads-site');
const DOWNLOADS_DIR = path.join(__dirname, 'tmp', 'downloads');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      fs.readFile(path.join(SITE_DIR, req.url), (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200);
        res.end(data);
      });
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
  const context = await browser.newContext({ acceptDownloads: true });

  const actions = [];
  await context.exposeBinding('__wrRecordAction', (_s, action) => actions.push(action));
  await context.exposeBinding('__wrControl', async () => {});
  await context.addInitScript({ path: path.join(__dirname, '..', 'src', 'injected.js') });

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  context.on('page', (page) => {
    page.on('download', async (download) => {
      const savedPath = path.join(DOWNLOADS_DIR, `${Date.now()}-${download.suggestedFilename()}`);
      await download.saveAs(savedPath);
      const parsed = await parseTabularFile(savedPath);
      actions.push({
        type: 'download',
        suggestedFilename: download.suggestedFilename(),
        headers: parsed ? parsed.headers : null,
        rows: parsed ? parsed.rows : null,
        timestamp: Date.now(),
      });
    });
  });

  const page = await context.newPage();
  const startUrl = `http://127.0.0.1:${port}/downloads.html`;
  await page.goto(startUrl);
  await page.waitForTimeout(150);

  await page.click('#download-csv');
  await page.waitForTimeout(300);
  await page.click('#download-xlsx');
  await page.waitForTimeout(300);

  const downloadActions = actions.filter((a) => a.type === 'download');
  assert.strictEqual(downloadActions.length, 2, `expected 2 download actions, got ${downloadActions.length}`);

  const expectedHeaders = ['AWB', 'Status', 'Weight'];
  const expectedRows = [
    ['1234567890', 'Delivered', '2.5kg'],
    ['9876543210', 'In Transit', '1.2kg'],
  ];

  assert.deepStrictEqual(downloadActions[0].headers, expectedHeaders);
  assert.deepStrictEqual(downloadActions[0].rows, expectedRows);
  console.log('ok - a real CSV download is captured and parsed into headers + rows');

  assert.deepStrictEqual(downloadActions[1].headers, expectedHeaders);
  assert.deepStrictEqual(downloadActions[1].rows, expectedRows);
  console.log('ok - a real XLSX download is captured and parsed into headers + rows');

  const session = { startUrl, recordedAt: new Date().toISOString(), actions };
  const spec = generators.playwright(session, { testName: 'download reports' });

  fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'tmp', 'downloads.spec.ts'), spec);

  assert.strictEqual((spec.match(/await Promise\.all\(\[/g) || []).length, 2, 'expected 2 paired downloads in generated spec');
  const clickCount = (spec.match(/getByTestId\("download-report"\)\.click\(\)/g) || []).length;
  assert.strictEqual(clickCount, 1, `expected the csv-download click to appear exactly once, got ${clickCount}`);
  console.log('ok - generated Playwright spec pairs both downloads with their triggering clicks, no duplicate click lines');

  await browser.close();
  server.close();
  console.log('\nAll download-capture tests passed. Generated spec written to test/tmp/downloads.spec.ts for replay.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
