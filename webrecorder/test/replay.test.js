// The strongest check we have: record a flow with the REAL recorder, generate
// the Playwright spec with the REAL generator, then execute that spec with
// @playwright/test against the same fixture site. Exercises exact-match
// locators, table selectors, download pairing and the download helper in a
// real browser. Needs @playwright/test (+ exceljs) resolvable from
// REPLAY_PROJECT_DIR; skips cleanly when that isn't set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Must stay async: the fixture server lives in this process, and a *Sync exec
// would block the event loop so the child Playwright run could never reach it.
function run(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}\n${stdout}\n${stderr}`))));
  });
}
const { record } = require('../src/recorder');
const generators = require('../src/generators');
const { serveDir, check } = require('./helpers');

const REPLAY_PROJECT_DIR = process.env.REPLAY_PROJECT_DIR;
const SITE = path.join(__dirname, 'fixtures', 'replay-site');

async function main() {
  if (!REPLAY_PROJECT_DIR) {
    console.log('skip - REPLAY_PROJECT_DIR not set (needs a project with @playwright/test and exceljs installed)');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webrecorder-replay-'));
  const { server, baseUrl } = await serveDir(SITE);

  const out = path.join(tmp, 'session.json');
  await record({
    url: `${baseUrl}/index.html`,
    out,
    headless: true,
    drive: async (page) => {
      await page.click('#username');
      await page.type('#username', 'alice');
      await page.click('#password');
      await page.type('#password', 'hunter2');
      await page.click('#remember-label', { position: { x: 60, y: 8 } }); // label click -> single `check`
      await page.selectOption('#theme-select', 'dark');
      await page.getByRole('button', { name: 'Save', exact: true }).click(); // sits next to "Save as draft"
      await page.waitForURL(/results\.html$/);
      await page.keyboard.press('F8');
      await page.locator('#results-table td').first().click({ modifiers: ['Control'] });
      await page.click('#welcome');
      await page.keyboard.press('F8');
      await page.click('#download-report');
      await page.waitForTimeout(300);
    },
  });
  const session = JSON.parse(fs.readFileSync(out, 'utf8'));

  await check('replay: recorded flow has the expected shape', async () => {
    const t = session.actions.map((a) => a.type);
    assert.deepStrictEqual(t, [
      'click', 'fill', 'click', 'fill', 'check', 'selectOption', 'click', 'navigate',
      'assertTable', 'assertText', 'click', 'download',
    ], t.join(','));
    const save = session.actions[6].selector.candidates[0];
    assert.strictEqual(save.engine, 'role');
    assert.strictEqual(save.name, 'Save');
  });

  const spec = generators.playwright(session, { testName: 'replay flow' });
  const specDir = path.join(REPLAY_PROJECT_DIR, 'tests');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'generated-replay.spec.ts');
  fs.writeFileSync(specPath, spec);

  await check('replay: generated Playwright spec passes against the live fixture', async () => {
    assert.match(spec, /getByRole\("button", \{ name: "Save", exact: true \}\)/);
    await run('npx', ['playwright', 'test', 'tests/generated-replay.spec.ts', '--reporter=line'], {
      cwd: REPLAY_PROJECT_DIR,
      env: process.env,
    });
  });

  fs.rmSync(specPath, { force: true });
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nReplay test passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
