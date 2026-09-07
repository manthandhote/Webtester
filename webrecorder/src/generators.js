// session.json -> test code strings. Must never touch a browser.
const { parseCsvRows, cellToString } = require('./tabular');

function jsStr(v) {
  return JSON.stringify(v == null ? '' : v);
}

// JSON string/array literals are also valid Python literals for the values we
// emit (strings and lists of strings only).
function pyStr(v) {
  return JSON.stringify(v == null ? '' : v);
}

function topCandidate(selector) {
  return selector.candidates[0];
}

// The text engine's assertion would just check the text against itself.
// Reorder so the highest-ranked non-text candidate leads. Only for assertText:
// for a click, a text selector is a perfectly good primary.
function orderedCandidatesForAssertion(selector) {
  const candidates = selector.candidates;
  if (candidates[0].engine !== 'text') return candidates;
  const nonText = candidates.find((c) => c.engine !== 'text');
  if (!nonText) return candidates;
  return [nonText, ...candidates.filter((c) => c !== nonText)];
}

function candidatesFor(action) {
  return action.type === 'assertText' ? orderedCandidatesForAssertion(action.selector) : action.selector.candidates;
}

// Sessions recorded before `kind` existed carry a boolean `native`.
function tableKind(action) {
  if (action.kind) return action.kind;
  return action.native ? 'table' : 'children';
}

function tableSelectors(action) {
  switch (tableKind(action)) {
    case 'table':
      return {
        rowSel: action.headerRowInBody ? ':scope > tbody > tr:nth-child(n+2)' : ':scope > tbody > tr',
        cellSel: ':scope > td, :scope > th',
      };
    case 'aria':
      return {
        rowSel: '[role="row"]:not(:has([role="columnheader"]))',
        cellSel: '[role="cell"], [role="gridcell"], [role="rowheader"]',
      };
    default:
      return { rowSel: ':scope > *', cellSel: ':scope > *' };
  }
}

// A `download` action must be paired with the click (or key press) that
// triggered it: the listener has to be armed before the trigger fires, or the
// event can be missed. Computed as one up-front pass, before any code is
// emitted — deciding it while iterating forward would be too late, since the
// trigger's own line would already have been emitted.
//
// Clicks within BURST_WINDOW_MS of each other immediately before a download
// are treated as one burst and the EARLIEST is the trigger: a common download
// idiom creates a hidden <a>, clicks it, and removes it, which used to record
// a second click on an element that no longer exists on replay. (injected.js
// now drops untrusted clicks at the source; this stays as defense in depth
// and for sessions recorded before that.)
const BURST_WINDOW_MS = 50;
const TRIGGER_TYPES = new Set(['click', 'press']);

function computeDownloadPairing(actions) {
  const consumed = new Set();
  const triggerIndexByDownloadIndex = new Map();

  actions.forEach((action, index) => {
    if (action.type !== 'download') return;
    const prev = actions[index - 1];
    if (!prev || !TRIGGER_TYPES.has(prev.type) || consumed.has(index - 1)) {
      triggerIndexByDownloadIndex.set(index, null);
      return;
    }
    let earliestInBurst = index - 1;
    let cursor = index - 2;
    while (prev.type === 'click' && cursor >= 0 && actions[cursor].type === 'click' && !consumed.has(cursor)) {
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

// exact: true everywhere a name/label/placeholder is matched. The recorded
// candidate was verified unique by exact match; Playwright's default substring
// match would turn "Save" into a strict-mode violation next to "Save as draft".
function playwrightLocator(candidate) {
  switch (candidate.engine) {
    case 'testid':
      if (candidate.attr === 'data-testid') return `page.getByTestId(${jsStr(candidate.value)})`;
      return `page.locator(${jsStr(candidate.css)})`;
    case 'role':
      return `page.getByRole(${jsStr(candidate.role)}, { name: ${jsStr(candidate.name)}, exact: true })`;
    case 'label':
      return `page.getByLabel(${jsStr(candidate.name)}, { exact: true })`;
    case 'placeholder':
      return `page.getByPlaceholder(${jsStr(candidate.value)}, { exact: true })`;
    case 'text':
      return `page.getByText(${jsStr(candidate.value)}, { exact: true })`;
    default:
      if (candidate.css) return `page.locator(${jsStr(candidate.css)})`;
      return `page.locator(${jsStr('xpath=' + candidate.xpath)})`;
  }
}

function playwrightTrigger(action) {
  const loc = playwrightLocator(topCandidate(action.selector));
  return action.type === 'press' ? `${loc}.press(${jsStr(action.key)})` : `${loc}.click()`;
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
      return action.label
        ? [`${i}await ${loc()}.selectOption({ label: ${jsStr(action.label)} });`]
        : [`${i}await ${loc()}.selectOption(${jsStr(action.value)});`];
    case 'setInputFiles':
      return [
        `${i}// files are basenames as recorded; point these at real paths before running`,
        `${i}await ${loc()}.setInputFiles([${action.files.map(jsStr).join(', ')}]);`,
      ];
    case 'press':
      return [`${i}await ${loc()}.press(${jsStr(action.key)});`];
    case 'assertValue':
      return [`${i}await expect(${loc()}).toHaveValue(${jsStr(action.value)});`];
    case 'assertText': {
      const candidate = orderedCandidatesForAssertion(action.selector)[0];
      return [`${i}await expect(${playwrightLocator(candidate)}).toContainText(${jsStr(action.text)}, { useInnerText: true });`];
    }
    case 'assertVisible':
      return [`${i}await expect(${loc()}).toBeVisible();`];
    case 'assertTable': {
      const { rowSel, cellSel } = tableSelectors(action);
      const rowsVar = `tableRows${index}`;
      const tableVar = `table${index}`;
      return [
        `${i}const ${rowsVar} = ${jsStr(action.rows)};`,
        `${i}const ${tableVar} = ${loc()};`,
        `${i}await expect(${tableVar}.locator(${jsStr(rowSel)})).toHaveCount(${rowsVar}.length);`,
        `${i}for (let r = 0; r < ${rowsVar}.length; r++) {`,
        `${i}  const cells = await ${tableVar}.locator(${jsStr(rowSel)}).nth(r).locator(${jsStr(cellSel)}).allInnerTexts();`,
        `${i}  expect(cells.map((c) => c.replace(/\\s+/g, ' ').trim())).toEqual(${rowsVar}[r]);`,
        `${i}}`,
      ];
    }
    default:
      return [`${i}// unsupported action type: ${action.type}`];
  }
}

// Emitted verbatim from tabular.js so the generated test parses a download
// exactly the way the recorder did.
const READ_TABULAR_DOWNLOAD_HELPER = [
  parseCsvRows.toString(),
  '',
  cellToString.toString(),
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
  '      grid.push(row.values.slice(1).map(cellToString));',
  '    });',
  '    return { headers: grid[0] || [], rows: grid.slice(1) };',
  '  }',
  "  const grid = parseCsvRows(require('fs').readFileSync(filePath, 'utf8'));",
  '  return { headers: grid[0] || [], rows: grid.slice(1) };',
  '}',
];

function playwrightDownloadStep(action, triggerAction, index) {
  const i = '  ';
  const dlVar = `download${index}`;
  const lines = [
    `${i}const [${dlVar}] = await Promise.all([`,
    `${i}  page.waitForEvent('download'),`,
    `${i}  ${playwrightTrigger(triggerAction)},`,
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
      if (triggerIndex != null) {
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

function seleniumKey(key) {
  return `Keys.${KEY_TO_SELENIUM[key] || key.toUpperCase()}`;
}

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

  const { by, value } = seleniumBy(candidatesFor(action));

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
      lines.push(`${i}el.send_keys(${seleniumKey(action.key)})`);
      break;
    case 'assertValue':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}assert el.get_attribute("value") == ${pyStr(action.value)}`);
      break;
    case 'assertText':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}assert ${pyStr(action.text)} in " ".join(el.text.split())`);
      break;
    case 'assertVisible':
      lines.push(`${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}assert el.is_displayed()`);
      break;
    case 'assertTable': {
      const { rowSel, cellSel } = tableSelectors(action);
      lines.push(`${i}table_el_${index} = wait_visible(driver, ${by}, ${pyStr(value)})`);
      lines.push(`${i}expected_rows_${index} = ${pyStr(action.rows)}`);
      lines.push(`${i}row_elements_${index} = table_el_${index}.find_elements(By.CSS_SELECTOR, ${pyStr(rowSel)})`);
      lines.push(`${i}assert len(row_elements_${index}) == len(expected_rows_${index})`);
      lines.push(`${i}for r, row_el in enumerate(row_elements_${index}):`);
      lines.push(`${i}    cells = row_el.find_elements(By.CSS_SELECTOR, ${pyStr(cellSel)})`);
      lines.push(`${i}    cell_texts = [" ".join(c.text.split()) for c in cells]`);
      lines.push(`${i}    assert cell_texts == expected_rows_${index}[r]`);
      break;
    }
    default:
      lines.push(`${i}# unsupported action type: ${action.type}`);
  }
  return lines;
}

function seleniumDownloadStep(action, triggerAction, index) {
  const i = '    ';
  const { by, value } = seleniumBy(triggerAction.selector.candidates);
  const lines = [
    `${i}before_files_${index} = set(os.listdir(driver.download_dir))`,
    `${i}el = wait_visible(driver, ${by}, ${pyStr(value)})`,
    triggerAction.type === 'press' ? `${i}el.send_keys(${seleniumKey(triggerAction.key)})` : `${i}el.click()`,
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

const SELENIUM_DOWNLOAD_HELPERS = [
  'def wait_for_new_file(directory, before_files, timeout=10):',
  '    end = time.time() + timeout',
  '    while time.time() < end:',
  '        new_files = set(os.listdir(directory)) - before_files',
  '        new_files = {f for f in new_files if not f.endswith((".crdownload", ".tmp"))}',
  '        if new_files:',
  '            return os.path.join(directory, new_files.pop())',
  '        time.sleep(0.2)',
  '    raise TimeoutError(f"No new file appeared in {directory}")',
  '',
  '',
  '# Cell stringification mirrors the recorder: None -> "", datetimes -> ISO-8601 with',
  '# millisecond precision and a Z suffix (what exceljs/JS Date produce), else str().',
  'def _cell_to_str(v):',
  '    if v is None:',
  '        return ""',
  '    if isinstance(v, datetime.datetime):',
  '        return v.isoformat(timespec="milliseconds") + "Z"',
  '    return str(v)',
  '',
  '',
  'def read_tabular_file(path):',
  '    if path.lower().endswith((".xlsx", ".xls")):',
  '        import openpyxl  # pip install openpyxl to use this',
  '        wb = openpyxl.load_workbook(path, data_only=True)',
  '        sheet = wb[wb.sheetnames[0]]',
  '        grid = [[_cell_to_str(c.value) for c in row] for row in sheet.iter_rows()]',
  '    else:',
  '        with open(path, newline="", encoding="utf-8-sig") as f:',
  '            grid = list(csv.reader(f))',
  '    headers = grid[0] if grid else []',
  '    rows = grid[1:]',
  '    return {"headers": headers, "rows": rows}',
];

function seleniumPython(session, { testName } = {}) {
  const actions = session.actions;
  const hasDownload = actions.some((a) => a.type === 'download');

  const lines = [];
  lines.push('import pytest');
  if (hasDownload) {
    lines.push('import os');
    lines.push('import time');
    lines.push('import csv');
    lines.push('import datetime');
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
    lines.push(...SELENIUM_DOWNLOAD_HELPERS);
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
      if (triggerIndex != null) {
        lines.push(...seleniumDownloadStep(action, actions[triggerIndex], index));
        return;
      }
      lines.push(`    # download with no preceding click/press to pair it with; skipping`);
      return;
    }
    lines.push(...seleniumStep(action, index));
  });
  lines.push('');
  return lines.join('\n');
}

// ---------------- JSON suite ----------------

function keyRowsByHeader(headers, rows) {
  const keys = [];
  const seen = new Set();
  const width = Math.max(headers ? headers.length : 0, ...rows.map((r) => r.length), 0);
  for (let c = 0; c < width; c++) {
    let key = (headers && headers[c]) || `col_${c}`;
    if (seen.has(key)) key = `${key}_${c}`;
    seen.add(key);
    keys.push(key);
  }
  return rows.map((row) => {
    const keyed = {};
    row.forEach((cellValue, c) => {
      keyed[keys[c]] = cellValue;
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

  const candidates = candidatesFor(action);
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
  if (action.type === 'assertTable') {
    step.kind = tableKind(action);
    step.headers = action.headers;
    step.rows = keyRowsByHeader(action.headers, action.rows);
  }

  return step;
}

function jsonSuite(session, { testName } = {}) {
  const suite = {
    name: testName || 'recorded session',
    startUrl: session.startUrl,
    recordedAt: session.recordedAt,
    steps: session.actions.map(toStep),
  };
  return JSON.stringify(suite, null, 2) + '\n';
}

module.exports = { playwright, seleniumPython, jsonSuite };
