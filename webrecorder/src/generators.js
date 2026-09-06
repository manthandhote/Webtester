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

function playwrightStep(action) {
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
    default:
      return [`${i}// unsupported action type: ${action.type}`];
  }
}

function playwright(session, { testName } = {}) {
  const lines = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test(${jsStr(testName || 'recorded session')}, async ({ page }) => {`);
  lines.push(`  await page.goto(${jsStr(session.startUrl)});`);
  for (const action of session.actions) {
    lines.push(...playwrightStep(action));
  }
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

function seleniumStep(action) {
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
    default:
      lines.push(`${i}# unsupported action type: ${action.type}`);
  }
  return lines;
}

function seleniumPython(session, { testName } = {}) {
  const lines = [];
  lines.push('import pytest');
  lines.push('from selenium import webdriver');
  lines.push('from selenium.webdriver.common.by import By');
  lines.push('from selenium.webdriver.common.keys import Keys');
  lines.push('from selenium.webdriver.support.ui import WebDriverWait, Select');
  lines.push('from selenium.webdriver.support import expected_conditions as EC');
  lines.push('');
  lines.push('');
  lines.push('@pytest.fixture');
  lines.push('def driver():');
  lines.push('    d = webdriver.Chrome()');
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
  lines.push(`def ${toPyFunctionName(testName)}(driver):`);
  lines.push(`    driver.get(${pyStr(session.startUrl)})`);
  for (const action of session.actions) {
    lines.push(...seleniumStep(action));
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------- JSON suite ----------------

function toStep(action) {
  if (action.type === 'navigate') {
    return { type: 'navigate', url: action.url };
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

  return step;
}

function jsonSuite(session, { testName } = {}) {
  const steps = [];
  for (const action of session.actions) {
    if (action.type === 'navigate' && action.implicit) continue;
    steps.push(toStep(action));
  }
  const suite = {
    name: testName || 'recorded session',
    startUrl: session.startUrl,
    recordedAt: session.recordedAt,
    steps,
  };
  return JSON.stringify(suite, null, 2) + '\n';
}

module.exports = { playwright, seleniumPython, jsonSuite };
