// session.json -> test code strings. Must never touch a browser.

function jsStr(v) {
  return JSON.stringify(v == null ? '' : v);
}

function pyStr(v) {
  return JSON.stringify(v == null ? '' : v);
}

function topCandidate(selector) {
  return selector.candidates[0];
}

// The text engine's assertion would just check the text against itself.
// Reorder so the highest-ranked non-text candidate leads.
function orderedCandidatesForAssertion(selector) {
  const candidates = selector.candidates;
  if (candidates[0].engine !== 'text') return candidates;
  const nonText = candidates.find((c) => c.engine !== 'text');
  if (!nonText) return candidates;
  return [nonText, ...candidates.filter((c) => c !== nonText)];
}

// A `download` action must be paired with the click that triggered it (the
// listener needs to be armed before the click fires). Naively pairing with
// "whatever click immediately precedes the download" breaks on the common
// vanilla-JS download pattern — create a hidden <a>, click it, remove it —
// because that synthesizes a SECOND click event (on a throwaway element with
// no stable selector) a few milliseconds after the real button click. So
// instead: walk back through a burst of clicks that all land within
// BURST_WINDOW_MS of each other immediately before the download, treat the
// EARLIEST one as the real trigger (what the user actually clicked), and
// drop the rest of the burst entirely — they're synthetic side effects, not
// separate user actions. This is computed as one up-front pass, before any
// code is emitted, since deciding it while iterating forward would be too
// late (the synthetic click's line would already have been emitted).
const BURST_WINDOW_MS = 50;

function computeDownloadPairing(actions) {
  const consumed = new Set();
  const triggerIndexByDownloadIndex = new Map();

  actions.forEach((action, index) => {
    if (action.type !== 'download') return;
    const prev = actions[index - 1];
    if (!prev || prev.type !== 'click' || consumed.has(index - 1)) {
      triggerIndexByDownloadIndex.set(index, null);
      return;
    }
    // The click immediately before a download always pairs with it, no matter
    // how long the download itself took to fire (that gap is unbounded — real
    // downloads take real time). The burst window only applies going further
    // back, between one click and the next: that's what catches a synthetic
    // click fired milliseconds after the real one.
    let earliestInBurst = index - 1;
    let cursor = index - 2;
    while (cursor >= 0 && actions[cursor].type === 'click' && !consumed.has(cursor)) {
      if (actions[cursor + 1].timestamp - actions[cursor].timestamp > BURST_WINDOW_MS) break;
      earliestInBurst = cursor;
      cursor--;
    }
    triggerIndexByDownloadIndex.set(index, earliestInBurst);
    for (let i = earliestInBurst; i < index; i++) consumed.add(i);
  });

  return { consumed, triggerIndexByDownloadIndex };
}

// ---------------- Playwright ----------------

function playwrightLocator(candidate) {
  switch (candidate.engine) {
    case 'testid':
      if (candidate.attr === 'data-testid') return `page.getByTestId(${jsStr(candidate.value)})`;
      return `page.locator(${jsStr(candidate.css)})`;
    case 'role':
      return `page.getByRole(${jsStr(candidate.role)}, { name: ${jsStr(candidate.name)} })`;
    case 'label':
      return `page.getByLabel(${jsStr(candidate.name)})`;
    case 'placeholder':
      return `page.getByPlaceholder(${jsStr(candidate.value)})`;
    case 'text':
      return `page.getByText(${jsStr(candidate.value)}, { exact: true })`;
    case 'id':
    case 'name':
    case 'css':
    default:
      if (candidate.css) return `page.locator(${jsStr(candidate.css)})`;
      return `page.locator(${jsStr('xpath=' + candidate.xpath)})`;
  }
}

function playwrightStep(action, index) {
  const i = '  ';
  const loc = () => playwrightLocator(topCandidate(action.selector));
  switch (action.type) {
    case 'navigate':
      return action.implicit
        ? [`${i}await expect(page).toHaveURL(${jsStr(action.url)});`]
        : [`${i}await page.goto(${jsStr(action.url)});`];
    case 'click':
      return [`${i}await ${loc()}.click();`];
    case 'check':
      return [`${i}await ${loc()}.check();`];
    case 'uncheck':
      return [`${i}await ${loc()}.uncheck();`];
    case 'fill':
      return [`${i}await ${loc()}.fill(${jsStr(action.value)});`];
    case 'selectOption':
      return [`${i}await ${loc()}.selectOption({ label: ${jsStr(action.label)} });`];
    case 'setInputFiles':
      return [`${i}await ${loc()}.setInputFiles([${action.files.map(jsStr).join(', ')}]);`];
    case 'press':
      return [`${i}await ${loc()}.press(${jsStr(action.key)});`];
    case 'assertValue':
      return [`${i}await expect(${loc()}).toHaveValue(${jsStr(action.value)});`];
    case 'assertText': {
      const candidate = orderedCandidatesForAssertion(action.selector)[0];
      return [`${i}await expect(${playwrightLocator(candidate)}).toContainText(${jsStr(action.text)});`];
    }
    case 'assertVisible':
      return [`${i}await expect(${loc()}).toBeVisible();`];
    case 'assertTable': {
      const rowSel = action.native ? 'tbody tr' : ':scope > *';
      const cellSel = action.native ? 'td, th' : ':scope > *';
      const varName = `tableRows${index}`;
      return [
        `${i}const ${varName} = ${jsStr(action.rows)};`,
        `${i}await expect(${loc()}.locator(${jsStr(rowSel)})).toHaveCount(${varName}.length);`,
        `${i}for (let r = 0; r < ${varName}.length; r++) {`,
        `${i}  const cells = await ${loc()}.locator(${jsStr(rowSel)}).nth(r).locator(${jsStr(cellSel)}).allTextContents();`,
        `${i}  for (let c = 0; c < ${varName}[r].length; c++) {`,
        `${i}    expect(cells[c].trim()).toBe(${varName}[r][c]);`,
        `${i}  }`,
        `${i}}`,
      ];
    }
    default:
      return [`${i}// unsupported action type: ${action.type}`];
  }
}

// Downloads must be paired with the click that triggers them via Promise.all,
// so the listener is armed before the click fires (otherwise the event can
// be missed). The helper below is only emitted when a download step actually
// captured file contents to verify.
const READ_TABULAR_DOWNLOAD_HELPER = [
  'function parseCsvText(text) {',
  '  const rows = [];',
  '  let row = [];',
  "  let field = '';",
  '  let inQuotes = false;',
  '  for (let i = 0; i < text.length; i++) {',
  '    const c = text[i];',
  '    if (inQuotes) {',
  "      if (c === '\"') { if (text[i + 1] === '\"') { field += '\"'; i++; } else { inQuotes = false; } }",
  '      else field += c;',
  "    } else if (c === '\"') inQuotes = true;",
  "    else if (c === ',') { row.push(field); field = ''; }",
  "    else if (c === '\\n') { row.push(field); field = ''; rows.push(row); row = []; }",
  "    else if (c === '\\r') { /* skip */ }",
  '    else field += c;',
  '  }',
  '  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }',
  "  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();",
  '  return rows;',
  '}',
  '',
  'async function readTabularDownload(download) {',
  '  const filePath = await download.path();',
  '  const name = download.suggestedFilename().toLowerCase();',
  "  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {",
  "    const ExcelJS = require('exceljs'); // npm install exceljs in your test project to use this",
  '    const workbook = new ExcelJS.Workbook();',
  '    await workbook.xlsx.readFile(filePath);',
  '    const worksheet = workbook.worksheets[0];',
  '    const grid = [];',
  '    worksheet.eachRow((row) => {',
  "      grid.push(row.values.slice(1).map((v) => (v == null ? '' : String(v))));",
  '    });',
  '    return { headers: grid[0] || [], rows: grid.slice(1) };',
  '  }',
  "  const fs = require('fs');",
  "  const grid = parseCsvText(fs.readFileSync(filePath, 'utf8'));",
  '  return { headers: grid[0] || [], rows: grid.slice(1) };',
  '}',
];

function playwrightDownloadStep(action, clickAction, index) {
  const i = '  ';
  const clickLoc = playwrightLocator(topCandidate(clickAction.selector));
  const dlVar = `download${index}`;
  const lines = [
    `${i}const [${dlVar}] = await Promise.all([`,
    `${i}  page.waitForEvent('download'),`,
    `${i}  ${clickLoc}.click(),`,
    `${i}]);`,
    `${i}expect(${dlVar}.suggestedFilename()).toBe(${jsStr(action.suggestedFilename)});`,
  ];
  if (action.headers && action.rows) {
    const dataVar = `downloadData${index}`;
    lines.push(`${i}const ${dataVar} = await readTabularDownload(${dlVar});`);
    lines.push(`${i}expect(${dataVar}.headers).toEqual(${jsStr(action.headers)});`);
    lines.push(`${i}expect(${dataVar}.rows).toEqual(${jsStr(action.rows)});`);
  }
  return lines;
}

function playwright(session, { testName } = {}) {
  const actions = session.actions;
  const hasParsedDownload = actions.some((a) => a.type === 'download' && a.headers && a.rows);

  const lines = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  if (hasParsedDownload) {
    lines.push(...READ_TABULAR_DOWNLOAD_HELPER);
    lines.push('');
  }
  lines.push(`test(${jsStr(testName || 'recorded session')}, async ({ page }) => {`);
  lines.push(`  await page.goto(${jsStr(session.startUrl)});`);

  const { consumed, triggerIndexByDownloadIndex } = computeDownloadPairing(actions);
  actions.forEach((action, index) => {
    if (consumed.has(index)) return;
    if (action.type === 'download') {
      const triggerIndex = triggerIndexByDownloadIndex.get(index);
      if (triggerIndex !== null && triggerIndex !== undefined) {
        lines.push(...playwrightDownloadStep(action, actions[triggerIndex], index));
        return;
      }
      lines.push(`  const download${index} = await page.waitForEvent('download');`);
      lines.push(`  expect(download${index}.suggestedFilename()).toBe(${jsStr(action.suggestedFilename)});`);
      return;
    }
    lines.push(...playwrightStep(action, index));
  });

  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

// ---------------- Selenium (pytest) ----------------

const KEY_TO_SELENIUM = {
  Enter: 'ENTER',
  Escape: 'ESCAPE',
  Tab: 'TAB',
  ArrowUp: 'ARROW_UP',
  ArrowDown: 'ARROW_DOWN',
};

function seleniumBy(candidates) {
  const withCss = candidates.find((c) => c.css);
  if (withCss) return { by: 'By.CSS_SELECTOR', value: withCss.css };
  const withXpath = candidates.find((c) => c.xpath);
  if (withXpath) return { by: 'By.XPATH', value: withXpath.xpath };
  return { by: 'By.CSS_SELECTOR', value: 'html' };
}

function toPyFunctionName(name) {
  const slug = (name || 'recorded_session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'recorded_session';
  return slug.startsWith('test_') ? slug : `test_${slug}`;
}

function seleniumStep(action, index) {
  const i = '    ';
  const lines = [];

  if (action.type === 'navigate') {
    if (action.implicit) {
      lines.push(`${i}WebDriverWait(driver, 10).until(EC.url_to_be(${pyStr(action.url)}))`);
    } else {
      lines.push(`${i}driver.get(${pyStr(action.url)})`);
    }
    return lines;
  }

  const { by, value } = seleniumBy(
    action.type === 'assertText' ? orderedCandidatesForAssertion(action.selector) : action.selector.candidates
  );

  switch (action.type) {
    case 'click':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}el.click()`);
      break;
    case 'check':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}if not el.is_selected():`);
      lines.push(`${i}    el.click()`);
      break;
    case 'uncheck':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}if el.is_selected():`);
      lines.push(`${i}    el.click()`);
      break;
    case 'fill':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}el.clear()`);
      lines.push(`${i}el.send_keys(${pyStr(action.value)})`);
      break;
    case 'selectOption':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      if (action.label) {
        lines.push(`${i}Select(el).select_by_visible_text(${pyStr(action.label)})`);
      } else {
        lines.push(`${i}Select(el).select_by_value(${pyStr(action.value)})`);
      }
      break;
    case 'setInputFiles':
      lines.push(`${i}el = wait_for(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}# files are basenames as recorded; point this at a real path before running`);
      lines.push(`${i}el.send_keys(${pyStr(action.files.join('\n'))})`);
      break;
    case 'press':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}el.send_keys(Keys.${KEY_TO_SELENIUM[action.key] || action.key.toUpperCase()})`);
      break;
    case 'assertValue':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}assert el.get_attribute("value") == ${pyStr(action.value)}`);
      break;
    case 'assertText':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}assert ${pyStr(action.text)} in el.text`);
      break;
    case 'assertVisible':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}assert el.is_displayed()`);
      break;
    case 'assertTable': {
      const rowSel = action.native ? 'tbody tr' : ':scope > *';
      const cellSel = action.native ? 'td, th' : ':scope > *';
      lines.push(`${i}table_el_${index} = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}expected_rows_${index} = ${pyStr(action.rows)}`);
      lines.push(`${i}row_elements_${index} = table_el_${index}.find_elements(By.CSS_SELECTOR, ${pyStr(rowSel)})`);
      lines.push(`${i}assert len(row_elements_${index}) == len(expected_rows_${index})`);
      lines.push(`${i}for r, row_el in enumerate(row_elements_${index}):`);
      lines.push(`${i}    cells = row_el.find_elements(By.CSS_SELECTOR, ${pyStr(cellSel)})`);
      lines.push(`${i}    cell_texts = [c.text.strip() for c in cells]`);
      lines.push(`${i}    assert cell_texts == expected_rows_${index}[r]`);
      break;
    }
    default:
      lines.push(`${i}# unsupported action type: ${action.type}`);
  }
  return lines;
}

function seleniumDownloadStep(action, clickAction, index) {
  const i = '    ';
  const { by, value } = seleniumBy(clickAction.selector.candidates);
  const lines = [
    `${i}before_files_${index} = set(os.listdir(driver.download_dir))`,
    `${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`,
    `${i}el.click()`,
    `${i}downloaded_path_${index} = wait_for_new_file(driver.download_dir, before_files_${index})`,
    `${i}assert os.path.basename(downloaded_path_${index}) == ${pyStr(action.suggestedFilename)}`,
  ];
  if (action.headers && action.rows) {
    lines.push(`${i}table_data_${index} = read_tabular_file(downloaded_path_${index})`);
    lines.push(`${i}assert table_data_${index}["headers"] == ${pyStr(action.headers)}`);
    lines.push(`${i}assert table_data_${index}["rows"] == ${pyStr(action.rows)}`);
  }
  return lines;
}

function seleniumPython(session, { testName } = {}) {
  const actions = session.actions;
  const hasDownload = actions.some((a) => a.type === 'download');

  const lines = [];
  lines.push('import pytest');
  if (hasDownload) {
    lines.push('import os');
    lines.push('import time');
    lines.push('import csv');
    lines.push('import tempfile');
  }
  lines.push('from selenium import webdriver');
  lines.push('from selenium.webdriver.common.by import By');
  lines.push('from selenium.webdriver.common.keys import Keys');
  lines.push('from selenium.webdriver.support.ui import WebDriverWait, Select');
  lines.push('from selenium.webdriver.support import expected_conditions as EC');
  lines.push('');
  lines.push('');
  lines.push('@pytest.fixture');
  lines.push('def driver():');
  if (hasDownload) {
    lines.push('    download_dir = tempfile.mkdtemp()');
    lines.push('    options = webdriver.ChromeOptions()');
    lines.push(
      '    options.add_experimental_option("prefs", {"download.default_directory": download_dir, "download.prompt_for_download": False})'
    );
    lines.push('    d = webdriver.Chrome(options=options)');
    lines.push('    d.download_dir = download_dir');
  } else {
    lines.push('    d = webdriver.Chrome()');
  }
  lines.push('    yield d');
  lines.push('    d.quit()');
  lines.push('');
  lines.push('');
  lines.push('def wait_for(driver, by, value, timeout=10):');
  lines.push('    return WebDriverWait(driver, timeout).until(EC.presence_of_element_located((by, value)))');
  lines.push('');
  lines.push('');
  lines.push('def wait_visible(driver, by, value, timeout=10):');
  lines.push('    return WebDriverWait(driver, timeout).until(EC.visibility_of_element_located((by, value)))');
  lines.push('');
  lines.push('');
  if (hasDownload) {
    lines.push('def wait_for_new_file(directory, before_files, timeout=10):');
    lines.push('    end = time.time() + timeout');
    lines.push('    while time.time() < end:');
    lines.push('        new_files = set(os.listdir(directory)) - before_files');
    lines.push('        new_files = {f for f in new_files if not f.endswith(".crdownload")}');
    lines.push('        if new_files:');
    lines.push('            return os.path.join(directory, new_files.pop())');
    lines.push('        time.sleep(0.2)');
    lines.push('    raise TimeoutError(f"No new file appeared in {directory}")');
    lines.push('');
    lines.push('');
    lines.push('def read_tabular_file(path):');
    lines.push('    if path.lower().endswith((".xlsx", ".xls")):');
    lines.push('        import openpyxl  # pip install openpyxl to use this');
    lines.push('        wb = openpyxl.load_workbook(path, data_only=True)');
    lines.push('        sheet = wb[wb.sheetnames[0]]');
    lines.push('        grid = [[("" if c.value is None else str(c.value)) for c in row] for row in sheet.iter_rows()]');
    lines.push('    else:');
    lines.push('        with open(path, newline="", encoding="utf-8") as f:');
    lines.push('            grid = list(csv.reader(f))');
    lines.push('    headers = grid[0] if grid else []');
    lines.push('    rows = grid[1:]');
    lines.push('    return {"headers": headers, "rows": rows}');
    lines.push('');
    lines.push('');
  }
  lines.push(`def ${toPyFunctionName(testName)}(driver):`);
  lines.push(`    driver.get(${pyStr(session.startUrl)})`);

  const { consumed, triggerIndexByDownloadIndex } = computeDownloadPairing(actions);
  actions.forEach((action, index) => {
    if (consumed.has(index)) return;
    if (action.type === 'download') {
      const triggerIndex = triggerIndexByDownloadIndex.get(index);
      if (triggerIndex !== null && triggerIndex !== undefined) {
        lines.push(...seleniumDownloadStep(action, actions[triggerIndex], index));
        return;
      }
      lines.push(`    # download with no preceding click to pair it with; skipping`);
      return;
    }
    lines.push(...seleniumStep(action, index));
  });
  lines.push('');
  return lines.join('\n');
}

// ---------------- JSON suite ----------------

function keyRowsByHeader(headers, rows) {
  return rows.map((row) => {
    const keyed = {};
    row.forEach((cellValue, colIndex) => {
      const key = (headers && headers[colIndex]) || `col_${colIndex}`;
      keyed[key] = cellValue;
    });
    return keyed;
  });
}

function toStep(action) {
  if (action.type === 'navigate') {
    return { type: 'navigate', url: action.url, implicit: !!action.implicit };
  }
  if (action.type === 'download') {
    const step = { type: 'download', suggestedFilename: action.suggestedFilename };
    if (action.headers && action.rows) {
      step.headers = action.headers;
      step.rows = keyRowsByHeader(action.headers, action.rows);
    }
    return step;
  }

  const candidates = orderedCandidatesForAssertion(action.selector);
  const step = {
    type: action.type,
    primary: candidates[0],
    fallbacks: candidates.slice(1, 4),
  };

  if (action.type === 'fill') step.value = action.value;
  if (action.type === 'selectOption') {
    step.value = action.value;
    step.label = action.label;
  }
  if (action.type === 'setInputFiles') step.files = action.files;
  if (action.type === 'press') step.key = action.key;
  if (action.type === 'assertValue') step.value = action.value;
  if (action.type === 'assertText') step.text = action.text;
  if (action.type === 'assertTable') step.rows = keyRowsByHeader(action.headers, action.rows);

  return step;
}

function jsonSuite(session, { testName } = {}) {
  const steps = session.actions.map(toStep);
  const suite = {
    name: testName || 'recorded session',
    startUrl: session.startUrl,
    recordedAt: session.recordedAt,
    steps,
  };
  return JSON.stringify(suite, null, 2) + '\n';
}

module.exports = { playwright, seleniumPython, jsonSuite };
