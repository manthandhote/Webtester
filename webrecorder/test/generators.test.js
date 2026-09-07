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

function cssCandidate(css, score = 10) {
  return { score, engine: 'css', css, xpath: null };
}

function miniSession(actions) {
  return { startUrl: 'https://example.com/', recordedAt: '2026-01-01T00:00:00.000Z', actions };
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
check('playwright: assertText avoids the text-engine trap and compares rendered text', () => {
  assert.match(
    pw,
    /await expect\(page\.locator\("#dashboard > div:nth-of-type\(2\) > span:nth-of-type\(1\)"\)\)\.toContainText\("Welcome, Alice!", \{ useInnerText: true \}\);/
  );
  assert.doesNotMatch(pw, /getByText\("Welcome, Alice!"/);
});
check('playwright: assertTable asserts row count and compares each row as an array', () => {
  assert.match(pw, /const tableRows\d+ = \[\["1234567890","Delivered"\],\["9876543210","In Transit"\]\];/);
  assert.match(pw, /const table\d+ = page\.locator\("#results-table"\);/);
  assert.match(pw, /await expect\(table\d+\.locator\(":scope > tbody > tr"\)\)\.toHaveCount\(tableRows\d+\.length\);/);
  assert.match(pw, /\.locator\(":scope > td, :scope > th"\)\.allInnerTexts\(\);/);
  assert.match(pw, /expect\(cells\.map\(\(c\) => c\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\)\)\.toEqual\(tableRows\d+\[r\]\);/);
});
check('playwright: download is paired with its triggering click via Promise.all', () => {
  assert.match(pw, /const \[download\d+\] = await Promise\.all\(\[/);
  assert.match(pw, /page\.waitForEvent\('download'\),/);
  assert.match(pw, /page\.getByTestId\("download-report"\)\.click\(\),/);
  assert.strictEqual((pw.match(/getByTestId\("download-report"\)\.click\(\)/g) || []).length, 1);
  assert.match(pw, /expect\(download\d+\.suggestedFilename\(\)\)\.toBe\("shipments-report\.csv"\);/);
  assert.match(pw, /expect\(downloadData\d+\.headers\)\.toEqual\(\["AWB","Status","Weight"\]\);/);
  assert.match(pw, /expect\(downloadData\d+\.rows\)\.toEqual\(\[\["1234567890","Delivered","2\.5kg"\],\["9876543210","In Transit","1\.2kg"\]\]\);/);
});
check('playwright: emits the download helper once, built from the shared tabular module', () => {
  assert.strictEqual((pw.match(/async function readTabularDownload/g) || []).length, 1);
  assert.strictEqual((pw.match(/function parseCsvRows\(text\)/g) || []).length, 1);
  assert.strictEqual((pw.match(/function cellToString\(v\)/g) || []).length, 1);
  const noDownload = miniSession(session.actions.filter((a) => a.type !== 'download'));
  assert.doesNotMatch(generators.playwright(noDownload, opts), /readTabularDownload/);
});
check('playwright: role/label/placeholder locators are exact (no substring strict-mode traps)', () => {
  const s = miniSession([
    { type: 'click', timestamp: 1, selector: { candidates: [{ score: 80, engine: 'role', role: 'button', name: 'Save', css: null, xpath: '//button[normalize-space(.)="Save"]' }] } },
    { type: 'fill', value: 'x', timestamp: 2, selector: { candidates: [{ score: 78, engine: 'label', name: 'Email', css: null, xpath: '//input[@id=//label[normalize-space(.)="Email"]/@for]' }] } },
    { type: 'fill', value: 'y', timestamp: 3, selector: { candidates: [{ score: 70, engine: 'placeholder', value: 'Search', css: 'input[placeholder="Search"]', xpath: null }] } },
  ]);
  const out = generators.playwright(s, opts);
  assert.match(out, /page\.getByRole\("button", \{ name: "Save", exact: true \}\)\.click\(\);/);
  assert.match(out, /page\.getByLabel\("Email", \{ exact: true \}\)\.fill\("x"\);/);
  assert.match(out, /page\.getByPlaceholder\("Search", \{ exact: true \}\)\.fill\("y"\);/);
});
check('playwright: selectOption without a label falls back to the value, never label: ""', () => {
  const s = miniSession([
    { type: 'selectOption', value: 'dark', label: null, timestamp: 1, selector: { candidates: [cssCandidate('#theme')] } },
  ]);
  const out = generators.playwright(s, opts);
  assert.match(out, /selectOption\("dark"\)/);
  assert.doesNotMatch(out, /label: ""/);
});
check('playwright: a download triggered by pressing Enter is paired with the press', () => {
  const s = miniSession([
    { type: 'press', key: 'Enter', timestamp: 1, selector: { candidates: [cssCandidate('#q')] } },
    { type: 'download', suggestedFilename: 'r.csv', headers: null, rows: null, timestamp: 900 },
  ]);
  const out = generators.playwright(s, opts);
  assert.match(out, /page\.waitForEvent\('download'\),\n\s+page\.locator\("#q"\)\.press\("Enter"\),/);
  assert.strictEqual((out.match(/press\("Enter"\)/g) || []).length, 1);
});
check('playwright: old sessions with native:true/false still generate table selectors', () => {
  const rows = [['a', 'b']];
  const nativeOut = generators.playwright(miniSession([{ type: 'assertTable', native: true, headers: [], rows, timestamp: 1, selector: { candidates: [cssCandidate('#t')] } }]), opts);
  const divOut = generators.playwright(miniSession([{ type: 'assertTable', native: false, headers: [], rows, timestamp: 1, selector: { candidates: [cssCandidate('#g')] } }]), opts);
  assert.match(nativeOut, /":scope > tbody > tr"/);
  assert.match(divOut, /":scope > \*"/);
});
check('playwright: ARIA grid and header-in-body tables get matching row selectors', () => {
  const rows = [['a', 'b']];
  const aria = generators.playwright(miniSession([{ type: 'assertTable', kind: 'aria', headers: ['H'], rows, timestamp: 1, selector: { candidates: [cssCandidate('#g')] } }]), opts);
  const hib = generators.playwright(miniSession([{ type: 'assertTable', kind: 'table', headerRowInBody: true, headers: ['H'], rows, timestamp: 1, selector: { candidates: [cssCandidate('#t')] } }]), opts);
  assert.match(aria, /\[role=\\"row\\"\]:not\(:has\(\[role=\\"columnheader\\"\]\)\)/);
  assert.match(hib, /":scope > tbody > tr:nth-child\(n\+2\)"/);
});

// ---- Selenium ----
const py = generators.seleniumPython(session, opts);
check('selenium: defines driver fixture and wait helpers', () => {
  assert.match(py, /def driver\(\):/);
  assert.match(py, /def wait_visible\(/);
  assert.match(py, /def wait_for\(/);
});
check('selenium: every interaction goes through an explicit wait', () => {
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
check('selenium: assertText avoids the text-engine trap and normalizes whitespace', () => {
  assert.match(py, /el = wait_visible\(driver, By\.CSS_SELECTOR, "#dashboard > div:nth-of-type\(2\) > span:nth-of-type\(1\)"\)/);
  assert.match(py, /assert "Welcome, Alice!" in " "\.join\(el\.text\.split\(\)\)/);
});
check('selenium: assertTable asserts row count and iterates cells with child selectors', () => {
  assert.match(py, /table_el_\d+ = wait_visible\(driver, By\.CSS_SELECTOR, "#results-table"\)/);
  assert.match(py, /expected_rows_\d+ = \[\["1234567890","Delivered"\],\["9876543210","In Transit"\]\]/);
  assert.match(py, /row_elements_\d+ = table_el_\d+\.find_elements\(By\.CSS_SELECTOR, ":scope > tbody > tr"\)/);
  assert.match(py, /cell_texts = \[" "\.join\(c\.text\.split\(\)\) for c in cells\]/);
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
  assert.match(py, /encoding="utf-8-sig"/);
  assert.match(py, /isoformat\(timespec="milliseconds"\) \+ "Z"/);
});
check('selenium: does not add download machinery when the session has no downloads', () => {
  const pyNoDownload = generators.seleniumPython(miniSession(session.actions.filter((a) => a.type !== 'download')), opts);
  assert.doesNotMatch(pyNoDownload, /download_dir/);
  assert.doesNotMatch(pyNoDownload, /import os/);
});
check('selenium: a download triggered by pressing Enter sends the key inside the paired step', () => {
  const s = miniSession([
    { type: 'press', key: 'Enter', timestamp: 1, selector: { candidates: [cssCandidate('#q')] } },
    { type: 'download', suggestedFilename: 'r.csv', headers: null, rows: null, timestamp: 900 },
  ]);
  const out = generators.seleniumPython(s, opts);
  assert.match(out, /before_files_1 = set\(os\.listdir\(driver\.download_dir\)\)\n\s+el = wait_visible\(driver, By\.CSS_SELECTOR, "#q"\)\n\s+el\.send_keys\(Keys\.ENTER\)/);
  assert.strictEqual((out.match(/Keys\.ENTER/g) || []).length, 1);
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
check('json: a click whose best selector is text keeps text as primary (reorder is assertText-only)', () => {
  const s = miniSession([
    { type: 'click', timestamp: 1, selector: { candidates: [{ score: 55, engine: 'text', value: 'Forgot password?', css: null, xpath: '//a[normalize-space(.)="Forgot password?"]' }, cssCandidate('#f > a')] } },
  ]);
  const out = JSON.parse(generators.jsonSuite(s, opts));
  assert.strictEqual(out.steps[0].primary.engine, 'text');
});
check('json: assertTable step keys rows by header and carries kind', () => {
  const tableStep = suite.steps.find((s) => s.type === 'assertTable');
  assert.deepStrictEqual(tableStep.rows, [
    { AWB: '1234567890', Status: 'Delivered' },
    { AWB: '9876543210', Status: 'In Transit' },
  ]);
  assert.strictEqual(tableStep.primary.engine, 'id');
  assert.strictEqual(tableStep.kind, 'table');
});
check('json: duplicate headers do not collapse columns', () => {
  const s = miniSession([
    { type: 'assertTable', kind: 'table', headers: ['Qty', 'Qty', ''], rows: [['1', '2', '3']], timestamp: 1, selector: { candidates: [cssCandidate('#t')] } },
  ]);
  const out = JSON.parse(generators.jsonSuite(s, opts));
  assert.deepStrictEqual(out.steps[0].rows, [{ Qty: '1', Qty_1: '2', col_2: '3' }]);
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

// ---- shared tabular helpers ----
const tabular = require('../src/tabular');
check('tabular: CSV parser handles BOM, quoted commas, escaped quotes, CRLF and embedded newlines', () => {
  const csv = '﻿AWB,Note\r\n"1,2","He said ""hi"""\r\n3,"multi\nline"\r\n';
  assert.deepStrictEqual(tabular.parseCsvRows(csv), [
    ['AWB', 'Note'],
    ['1,2', 'He said "hi"'],
    ['3', 'multi\nline'],
  ]);
});
check('tabular: cell stringification is stable across cell shapes', () => {
  assert.strictEqual(tabular.cellToString(null), '');
  assert.strictEqual(tabular.cellToString(2.5), '2.5');
  assert.strictEqual(tabular.cellToString(new Date(Date.UTC(2024, 0, 1))), '2024-01-01T00:00:00.000Z');
  assert.strictEqual(tabular.cellToString({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.strictEqual(tabular.cellToString({ formula: 'SUM(A1)', result: 7 }), '7');
  assert.strictEqual(tabular.cellToString({ text: 'link', hyperlink: 'http://x' }), 'link');
});

console.log('\nAll generator tests passed.');
