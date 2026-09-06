// Verifies all three generators produce sane output from the fixture, with no browser involved.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const generators = require('../src/generators');

const session = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'session.json'), 'utf8'));
const opts = { testName: 'login flow' };

function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (err) {
    console.error(`FAIL - ${label}`);
    throw err;
  }
}

// ---- Playwright ----
const pw = generators.playwright(session, opts);
check('playwright: imports test/expect', () => {
  assert.match(pw, /import \{ test, expect \} from '@playwright\/test';/);
});
check('playwright: starts with goto to startUrl', () => {
  assert.match(pw, /await page\.goto\("https:\/\/example\.com\/login"\);/);
});
check('playwright: fill uses top-ranked testid locator', () => {
  assert.match(pw, /await page\.getByTestId\("username-input"\)\.fill\("alice"\);/);
});
check('playwright: check uses id locator', () => {
  assert.match(pw, /await page\.locator\("#remember-me"\)\.check\(\);/);
});
check('playwright: click uses testid locator', () => {
  assert.match(pw, /await page\.getByTestId\("login-submit"\)\.click\(\);/);
});
check('playwright: implicit navigate becomes toHaveURL', () => {
  assert.match(pw, /await expect\(page\)\.toHaveURL\("https:\/\/example\.com\/dashboard"\);/);
  assert.doesNotMatch(pw, /page\.goto\("https:\/\/example\.com\/dashboard"\)/);
});
check('playwright: explicit navigate becomes goto', () => {
  assert.match(pw, /await page\.goto\("https:\/\/example\.com\/settings"\);/);
});
check('playwright: selectOption uses label', () => {
  assert.match(pw, /await page\.locator\("#theme-select"\)\.selectOption\(\{ label: "Dark Mode" \}\);/);
});
check('playwright: assertText avoids the text-engine trap (uses css fallback, not getByText)', () => {
  assert.match(pw, /await expect\(page\.locator\("#dashboard > div:nth-of-type\(2\) > span:nth-of-type\(1\)"\)\)\.toContainText\("Welcome, Alice!"\);/);
  assert.doesNotMatch(pw, /getByText\("Welcome, Alice!"/);
});
check('playwright: assertTable asserts row count and iterates cells', () => {
  assert.match(pw, /const tableRows\d+ = \[\["1234567890","Delivered"\],\["9876543210","In Transit"\]\];/);
  assert.match(pw, /await expect\(page\.locator\("#results-table"\)\.locator\("tbody tr"\)\)\.toHaveCount\(tableRows\d+\.length\);/);
  assert.match(pw, /expect\(cells\[c\]\.trim\(\)\)\.toBe\(tableRows\d+\[r\]\[c\]\);/);
});
check('playwright: download is paired with its triggering click via Promise.all', () => {
  assert.match(pw, /const \[download\d+\] = await Promise\.all\(\[/);
  assert.match(pw, /page\.waitForEvent\('download'\),/);
  assert.match(pw, /page\.getByTestId\("download-report"\)\.click\(\),/);
  assert.match(pw, /expect\(download\d+\.suggestedFilename\(\)\)\.toBe\("shipments-report\.csv"\);/);
  assert.match(pw, /expect\(downloadData\d+\.headers\)\.toEqual\(\["AWB","Status","Weight"\]\);/);
  assert.match(pw, /expect\(downloadData\d+\.rows\)\.toEqual\(\[\["1234567890","Delivered","2\.5kg"\],\["9876543210","In Transit","1\.2kg"\]\]\);/);
});
check('playwright: emits the readTabularDownload helper exactly once, only when needed', () => {
  const matches = pw.match(/async function readTabularDownload/g) || [];
  assert.strictEqual(matches.length, 1);
});

// ---- Selenium ----
const py = generators.seleniumPython(session, opts);
check('selenium: defines driver fixture and wait helpers', () => {
  assert.match(py, /def driver\(\):/);
  assert.match(py, /def wait_visible\(/);
  assert.match(py, /def wait_for\(/);
});
check('selenium: every interaction goes through an explicit wait', () => {
  const bodyLines = py.split('\n').filter((l) => l.trim().startsWith('el.') || l.includes('find_element'));
  assert.ok(!py.includes('find_element('), 'must not call find_element directly');
});
check('selenium: fill uses top candidate with a css', () => {
  assert.match(py, /el = wait_visible\(driver, By\.CSS_SELECTOR, "\[data-testid=\\"username-input\\"\]"\)/);
  assert.match(py, /el\.send_keys\("alice"\)/);
});
check('selenium: selectOption uses Select', () => {
  assert.match(py, /Select\(el\)\.select_by_visible_text\("Dark Mode"\)/);
});
check('selenium: implicit navigate uses EC.url_to_be', () => {
  assert.match(py, /EC\.url_to_be\("https:\/\/example\.com\/dashboard"\)/);
});
check('selenium: explicit navigate uses driver.get', () => {
  assert.match(py, /driver\.get\("https:\/\/example\.com\/settings"\)/);
});
check('selenium: assertText avoids the text-engine trap (falls back to css candidate)', () => {
  assert.match(py, /el = wait_visible\(driver, By\.CSS_SELECTOR, "#dashboard > div:nth-of-type\(2\) > span:nth-of-type\(1\)"\)/);
  assert.match(py, /assert "Welcome, Alice!" in el\.text/);
});
check('selenium: assertTable asserts row count and iterates cells', () => {
  assert.match(py, /table_el_\d+ = wait_visible\(driver, By\.CSS_SELECTOR, "#results-table"\)/);
  assert.match(py, /expected_rows_\d+ = \[\["1234567890","Delivered"\],\["9876543210","In Transit"\]\]/);
  assert.match(py, /row_elements_\d+ = table_el_\d+\.find_elements\(By\.CSS_SELECTOR, "tbody tr"\)/);
  assert.match(py, /assert cell_texts == expected_rows_\d+\[r\]/);
});
check('selenium: download uses a temp download dir, polls for the new file, then reads it', () => {
  assert.match(py, /options\.add_experimental_option\("prefs", \{"download\.default_directory": download_dir, "download\.prompt_for_download": False\}\)/);
  assert.match(py, /before_files_\d+ = set\(os\.listdir\(driver\.download_dir\)\)/);
  assert.match(py, /el = wait_visible\(driver, By\.CSS_SELECTOR, "\[data-testid=\\"download-report\\"\]"\)/);
  assert.match(py, /downloaded_path_\d+ = wait_for_new_file\(driver\.download_dir, before_files_\d+\)/);
  assert.match(py, /assert os\.path\.basename\(downloaded_path_\d+\) == "shipments-report\.csv"/);
  assert.match(py, /assert table_data_\d+\["headers"\] == \["AWB","Status","Weight"\]/);
  assert.match(py, /assert table_data_\d+\["rows"\] == \[\["1234567890","Delivered","2\.5kg"\],\["9876543210","In Transit","1\.2kg"\]\]/);
});
check('selenium: does not add download machinery when no session has downloads', () => {
  const noDownloadSession = { ...session, actions: session.actions.filter((a) => a.type !== 'download') };
  const pyNoDownload = generators.seleniumPython(noDownloadSession, opts);
  assert.doesNotMatch(pyNoDownload, /download_dir/);
  assert.doesNotMatch(pyNoDownload, /import os/);
});

// ---- JSON suite ----
const suite = JSON.parse(generators.jsonSuite(session, opts));
check('json: has name/startUrl/recordedAt/steps', () => {
  assert.strictEqual(suite.name, 'login flow');
  assert.strictEqual(suite.startUrl, 'https://example.com/login');
  assert.ok(Array.isArray(suite.steps));
});
check('json: keeps both implicit and explicit navigations, flagged accordingly', () => {
  const navSteps = suite.steps.filter((s) => s.type === 'navigate');
  assert.strictEqual(navSteps.length, 2);
  assert.deepStrictEqual(navSteps[0], { type: 'navigate', url: 'https://example.com/dashboard', implicit: true });
  assert.deepStrictEqual(navSteps[1], { type: 'navigate', url: 'https://example.com/settings', implicit: false });
});
check('json: each element-based step keeps primary + up to 3 fallbacks', () => {
  for (const step of suite.steps) {
    if (step.type === 'navigate' || step.type === 'download') continue;
    assert.ok(step.primary, `step ${step.type} missing primary`);
    assert.ok(Array.isArray(step.fallbacks));
    assert.ok(step.fallbacks.length <= 3);
  }
});
check('json: assertText step promotes non-text candidate to primary', () => {
  const assertStep = suite.steps.find((s) => s.type === 'assertText');
  assert.strictEqual(assertStep.primary.engine, 'css');
  assert.strictEqual(assertStep.text, 'Welcome, Alice!');
});
check('json: assertTable step keys rows by header', () => {
  const tableStep = suite.steps.find((s) => s.type === 'assertTable');
  assert.deepStrictEqual(tableStep.rows, [
    { AWB: '1234567890', Status: 'Delivered' },
    { AWB: '9876543210', Status: 'In Transit' },
  ]);
  assert.strictEqual(tableStep.primary.engine, 'id');
});
check('json: download step has no selector but keys rows by header', () => {
  const downloadStep = suite.steps.find((s) => s.type === 'download');
  assert.strictEqual(downloadStep.suggestedFilename, 'shipments-report.csv');
  assert.strictEqual(downloadStep.primary, undefined);
  assert.deepStrictEqual(downloadStep.rows, [
    { AWB: '1234567890', Status: 'Delivered', Weight: '2.5kg' },
    { AWB: '9876543210', Status: 'In Transit', Weight: '1.2kg' },
  ]);
});

console.log('\nAll generator tests passed.');
