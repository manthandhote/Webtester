// Headless behavioral checks for injected.js against a real Chromium page.
// Uses the same context wiring as recorder.js (exposeBinding + addInitScript)
// but drives the page directly so each check can inspect the raw action stream.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const { launchOptions, check } = require('./helpers');

async function main() {
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext();
  const actions = [];

  await context.exposeBinding('__wrRecordAction', (_source, action) => {
    actions.push(action);
  });
  await context.exposeBinding('__wrControl', async () => {});
  await context.addInitScript({ path: path.join(__dirname, '..', 'src', 'injected.js') });

  const page = await context.newPage();
  // Always navigate for real: page.setContent() mutates the existing document
  // via document.open/write and never re-fires context init scripts.
  const load = async (html) => {
    actions.length = 0;
    await page.goto('data:text/html,' + encodeURIComponent(html));
    await page.waitForTimeout(100);
  };
  const settle = () => page.waitForTimeout(60);
  const types = () => actions.map((a) => a.type);
  const top = (a) => a.selector.candidates[0];
  const byEngine = (a, engine) => a.selector.candidates.find((c) => c.engine === engine);

  await load('<input id="name-field" type="text" /><button id=":r1:">Submit</button>');

  await check('12 keystrokes into a field produce exactly one fill action', async () => {
    await page.click('#name-field');
    await page.type('#name-field', 'abcdefghijkl', { delay: 5 });
    await page.click('body');
    await settle();
    const fills = actions.filter((a) => a.type === 'fill');
    assert.strictEqual(fills.length, 1, `got ${fills.length} fills: ${types()}`);
    assert.strictEqual(fills[0].value, 'abcdefghijkl');
  });

  await check('a real (trusted) click on the overlay panel records nothing', async () => {
    const before = actions.length;
    const box = await page.evaluate(() => {
      const host = Array.from(document.documentElement.children).find((el) => el.shadowRoot);
      const r = host.shadowRoot.getElementById('wr-finish').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await settle();
    assert.strictEqual(actions.length, before, `panel click recorded: ${types().slice(before)}`);
  });

  await check('a page with :r1:-style React ids does not produce #\\:r1\\: selectors', async () => {
    await page.getByText('Submit').click();
    await settle();
    const click = actions.filter((a) => a.type === 'click').pop();
    for (const c of click.selector.candidates) {
      assert.ok(!(c.css || '').includes('r1') && !(c.xpath || '').includes('r1'), JSON.stringify(c));
      assert.notStrictEqual(c.engine, 'id');
    }
  });

  await check('programmatic (untrusted) clicks are not recorded — hidden file input clicked by an Upload button', async () => {
    await load(
      '<button id="upload" onclick="document.getElementById(\'file\').click()">Upload</button>' +
        '<input id="file" type="file" style="display:none" />'
    );
    await page.click('#upload');
    await settle();
    assert.deepStrictEqual(types(), ['click']);
    assert.strictEqual(top(actions[0]).css, '#upload');
  });

  await check('clicking a <label> for a checkbox records one `check`, not click + check', async () => {
    await load('<label id="lbl"><input id="cb" type="checkbox" /> Remember me</label>');
    await page.click('#lbl', { position: { x: 60, y: 8 } });
    await settle();
    assert.deepStrictEqual(types(), ['check']);
    assert.strictEqual(top(actions[0]).css, '#cb');
  });

  await check('pending fill is flushed BEFORE a Tab/Escape press, keeping real order', async () => {
    await load('<input id="a" /><input id="b" />');
    await page.click('#a');
    await page.type('#a', 'hello');
    await page.keyboard.press('Tab');
    await settle();
    assert.deepStrictEqual(types().slice(0, 3), ['click', 'fill', 'press']);
    assert.strictEqual(actions[2].key, 'Tab');
  });

  await check('label[for] and role candidates resolve to the RIGHT input and stay unpenalized', async () => {
    await load(
      '<label for="u">Username</label><input id="u" name="u" />' +
        '<label for="p">Password</label><input id="p" name="p" type="password" />'
    );
    await page.click('#p');
    await settle();
    const click = actions[0];
    const label = byEngine(click, 'label');
    const role = byEngine(click, 'role');
    assert.strictEqual(label.score, 78, `label candidate penalized: ${JSON.stringify(label)}`);
    assert.match(label.xpath, /^\/\/input\[@id=\/\/label\[normalize-space\(\.\)="Password"\]\/@for\]$/);
    assert.strictEqual(role.score, 80, `role candidate penalized: ${JSON.stringify(role)}`);
    assert.strictEqual(role.name, 'Password');
    // The concrete xpath must select exactly the password input, not the one before it.
    const resolved = await page.evaluate(
      (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.id,
      label.xpath
    );
    assert.strictEqual(resolved, 'p');
  });

  await check('icon-only button gets its accessible name from the <img alt>', async () => {
    await load('<button id="x"><img alt="Close dialog" src="data:," /></button>');
    await page.click('#x');
    await settle();
    const role = byEngine(actions[0], 'role');
    assert.strictEqual(role.name, 'Close dialog');
    assert.strictEqual(role.score, 80);
  });

  await check('elements inside an open shadow root are checked for uniqueness in their own root', async () => {
    await load(
      '<div id="host"></div><script>' +
        'document.getElementById("host").attachShadow({mode:"open"}).innerHTML = \'<button id="inner">Go</button>\';' +
        '</script>'
    );
    await page.locator('#host').locator('#inner').click();
    await settle();
    const idCand = byEngine(actions[0], 'id');
    assert.strictEqual(idCand.score, 90, `shadow-root id candidate penalized: ${JSON.stringify(idCand)}`);
  });

  await check('the overlay panel survives body.innerHTML being replaced', async () => {
    await load('<div>app</div>');
    await page.evaluate(() => {
      document.body.innerHTML = '<div>rebuilt</div>';
    });
    await page.waitForTimeout(50);
    const present = await page.evaluate(() =>
      Array.from(document.documentElement.children).some((el) => el.shadowRoot && el.shadowRoot.getElementById('wr-finish'))
    );
    assert.ok(present, 'panel host missing after body rebuild');
  });

  await check('Ctrl+click in assert mode captures a table — outer rows only, headers from thead', async () => {
    await load(
      '<table id="results-table"><thead><tr><th>AWB</th><th>Status</th></tr></thead><tbody>' +
        '<tr><td>1234567890</td><td>Delivered <span style="display:none">hidden</span></td></tr>' +
        '<tr><td>9876543210</td><td><table><tr><td>nested</td></tr></table>In Transit</td></tr>' +
        '</tbody></table>'
    );
    await page.keyboard.press('F8');
    await page.locator('#results-table > tbody > tr > td').first().click({ modifiers: ['Control'] });
    await settle();
    assert.deepStrictEqual(types(), ['assertTable']);
    const t = actions[0];
    assert.strictEqual(t.kind, 'table');
    assert.deepStrictEqual(t.headers, ['AWB', 'Status']);
    assert.deepStrictEqual(t.rows, [
      ['1234567890', 'Delivered'],
      ['9876543210', 'nested In Transit'],
    ]);
    assert.strictEqual(top(t).css, '#results-table');
  });

  await check('Ctrl+click on a cell of an ARIA grid captures it with role-based rows', async () => {
    await load(
      '<div id="grid" role="grid">' +
        '<div role="row"><div role="columnheader">AWB</div><div role="columnheader">Status</div></div>' +
        '<div role="row"><div role="gridcell">111</div><div role="gridcell">Delivered</div></div>' +
        '<div role="row"><div role="gridcell">222</div><div role="gridcell">Lost</div></div>' +
        '</div>'
    );
    await page.keyboard.press('F8');
    await page.locator('[role="gridcell"]').first().click({ modifiers: ['Control'] });
    await settle();
    const t = actions[0];
    assert.strictEqual(t.type, 'assertTable');
    assert.strictEqual(t.kind, 'aria');
    assert.deepStrictEqual(t.headers, ['AWB', 'Status']);
    assert.deepStrictEqual(t.rows, [['111', 'Delivered'], ['222', 'Lost']]);
  });

  await check('Ctrl+click on a cell of a div grid walks up to the row container', async () => {
    await load(
      '<div id="g" class="grid">' +
        '<div class="row"><div class="c">a1</div><div class="c">a2</div></div>' +
        '<div class="row"><div class="c">b1</div><div class="c">b2</div></div>' +
        '</div>'
    );
    await page.keyboard.press('F8');
    await page.locator('.c').first().click({ modifiers: ['Control'] });
    await settle();
    const t = actions[0];
    assert.strictEqual(t.type, 'assertTable');
    assert.strictEqual(t.kind, 'children');
    assert.deepStrictEqual(t.rows, [['a1', 'a2'], ['b1', 'b2']]);
    assert.strictEqual(top(t).css, '#g');
  });

  await check('assertText records rendered (innerText) text, excluding hidden children', async () => {
    await load('<p id="msg">Welcome, <b>Alice</b>!<span style="display:none"> secret</span></p>');
    await page.keyboard.press('F8');
    await page.click('#msg');
    await settle();
    assert.deepStrictEqual(types(), ['assertText']);
    assert.strictEqual(actions[0].text, 'Welcome, Alice!');
  });

  await check('actions are not recorded while assert mode is on (typing, select changes, key presses)', async () => {
    await load('<input id="i" /><select id="s"><option>a</option><option>b</option></select>');
    await page.keyboard.press('F8');
    await page.focus('#i');
    await page.keyboard.type('zzz');
    await page.keyboard.press('Enter');
    await page.selectOption('#s', 'b');
    await settle();
    assert.deepStrictEqual(types(), []);
  });

  await browser.close();
  console.log('\nAll injected.js behavior tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
