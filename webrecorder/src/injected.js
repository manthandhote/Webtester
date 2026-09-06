// Runs INSIDE the recorded page (every frame, every page in the context).
// Must be dependency-free and defensive: the page is hostile/untrusted code.
(function () {
  if (window.__wrInstalled) return;
  window.__wrInstalled = true;

  var GENERATED_ID_RE = /^:r[0-9a-z]+:$/i;
  var HEX_RUN_RE = /[0-9a-f]{8,}/i;
  var GENERATED_PREFIX_RE = /^(mui|radix|headlessui|ember)/i;
  var TEST_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];
  var TEXT_TAGS = ['a', 'button', 'span', 'li', 'td', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  var KEY_MAP = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };

  var paused = false;
  var assertMode = false;
  var pendingFill = null; // { el, value }
  var actionCount = 0;
  var panelHost = null;
  var countEl = null;
  var statusEl = null;
  var assertStateEl = null;

  // ---------- string escaping ----------

  function escapeCssAttrValue(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function xpathLiteral(v) {
    v = String(v);
    if (v.indexOf('"') === -1) return '"' + v + '"';
    if (v.indexOf("'") === -1) return "'" + v + "'";
    var parts = v.split('"');
    var pieces = [];
    for (var i = 0; i < parts.length; i++) {
      pieces.push('"' + parts[i] + '"');
      if (i < parts.length - 1) pieces.push("'\"'");
    }
    return 'concat(' + pieces.join(', ') + ')';
  }

  // ---------- generated-id detection ----------

  function isGeneratedId(id) {
    if (!id) return true;
    if (/^[0-9]/.test(id)) return true;
    if (GENERATED_ID_RE.test(id)) return true;
    if (HEX_RUN_RE.test(id)) return true;
    if (GENERATED_PREFIX_RE.test(id)) return true;
    return false;
  }

  // ---------- role + accessible name ----------

  function getRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      var map = {
        button: 'button', submit: 'button', reset: 'button',
        checkbox: 'checkbox', radio: 'radio',
        text: 'textbox', email: 'textbox', password: 'textbox',
        search: 'searchbox', tel: 'textbox', url: 'textbox', number: 'spinbutton',
      };
      return map[type] || 'textbox';
    }
    return null;
  }

  function getAssociatedLabelText(el) {
    var tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].indexOf(tag) === -1) return null;
    if (el.id) {
      try {
        var label = document.querySelector('label[for="' + escapeCssAttrValue(el.id) + '"]');
        if (label) {
          var t1 = (label.textContent || '').trim().replace(/\s+/g, ' ');
          if (t1) return t1;
        }
      } catch (e) { /* ignore malformed id */ }
    }
    var ancestor = el.closest ? el.closest('label') : null;
    if (ancestor) {
      var t2 = (ancestor.textContent || '').trim().replace(/\s+/g, ' ');
      if (t2) return t2;
    }
    return null;
  }

  function computeAccessibleName(el) {
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var text = labelledBy.split(/\s+/).map(function (id) {
        var ref = document.getElementById(id);
        return ref ? (ref.textContent || '').trim() : '';
      }).filter(Boolean).join(' ');
      if (text) return text;
    }

    var labelText = getAssociatedLabelText(el);
    if (labelText) return labelText;

    var tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      var alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
    }

    if (tag === 'input') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if ((type === 'submit' || type === 'button') && el.value) return el.value.trim();
    }

    var placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    var innerText = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (innerText && innerText.length <= 80) return innerText;

    return null;
  }

  // ---------- concrete locator builders ----------

  function textXPath(tag, text) {
    return '//' + tag + '[normalize-space(.)=' + xpathLiteral(text) + ']';
  }

  function buildRoleLocator(el, name) {
    var tag = el.tagName.toLowerCase();
    if (el.getAttribute('aria-label') === name) {
      return {
        css: tag + '[aria-label="' + escapeCssAttrValue(name) + '"]',
        xpath: '//' + tag + '[@aria-label=' + xpathLiteral(name) + ']',
      };
    }
    if (tag === 'img' && el.getAttribute('alt') === name) {
      return { css: 'img[alt="' + escapeCssAttrValue(name) + '"]', xpath: '//img[@alt=' + xpathLiteral(name) + ']' };
    }
    if (tag === 'input') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if ((type === 'submit' || type === 'button') && el.value === name) {
        return { css: 'input[value="' + escapeCssAttrValue(name) + '"]', xpath: '//input[@value=' + xpathLiteral(name) + ']' };
      }
    }
    return { css: null, xpath: textXPath(tag, name) };
  }

  function buildLabelLocator(el, labelText) {
    var tag = el.tagName.toLowerCase();
    if (el.closest && el.closest('label')) {
      return { css: null, xpath: '//label[normalize-space(.)=' + xpathLiteral(labelText) + ']//' + tag };
    }
    var lit = xpathLiteral(labelText);
    return {
      css: null,
      xpath: '//label[normalize-space(.)=' + lit + ']/following::' + tag + '[1] | //label[normalize-space(.)=' + lit + ']/preceding::' + tag + '[1]',
    };
  }

  function buildNthOfTypePath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.id && !isGeneratedId(node.id)) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
      var idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  function checkUniqueness(css, xpath) {
    try {
      if (css) {
        return document.querySelectorAll(css).length === 1;
      }
      if (xpath) {
        var res = document.evaluate('count(' + xpath + ')', document, null, XPathResult.NUMBER_TYPE, null);
        return res.numberValue === 1;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function mkCandidate(score, engine, locators, extra) {
    var unique = checkUniqueness(locators.css, locators.xpath);
    var finalScore = unique ? score : score - 25;
    var candidate = { score: finalScore, engine: engine, css: locators.css || null, xpath: locators.xpath || null };
    if (extra) {
      for (var k in extra) candidate[k] = extra[k];
    }
    return candidate;
  }

  function collectCandidates(el) {
    var tag = el.tagName.toLowerCase();
    var candidates = [];

    for (var i = 0; i < TEST_ATTRS.length; i++) {
      var attr = TEST_ATTRS[i];
      var v = el.getAttribute(attr);
      if (v) {
        candidates.push(mkCandidate(100, 'testid', {
          css: '[' + attr + '="' + escapeCssAttrValue(v) + '"]',
          xpath: '//*[@' + attr + '=' + xpathLiteral(v) + ']',
        }, { attr: attr, value: v }));
        break;
      }
    }

    if (el.id && !isGeneratedId(el.id)) {
      candidates.push(mkCandidate(90, 'id', {
        css: '#' + CSS.escape(el.id),
        xpath: '//*[@id=' + xpathLiteral(el.id) + ']',
      }, { value: el.id }));
    }

    var role = getRole(el);
    var name = computeAccessibleName(el);
    if (role && name) {
      candidates.push(mkCandidate(80, 'role', buildRoleLocator(el, name), { role: role, name: name }));
    }

    if (['input', 'select', 'textarea'].indexOf(tag) !== -1) {
      var labelText = getAssociatedLabelText(el);
      if (labelText) {
        candidates.push(mkCandidate(78, 'label', buildLabelLocator(el, labelText), { name: labelText }));
      }
    }

    var placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      candidates.push(mkCandidate(70, 'placeholder', {
        css: tag + '[placeholder="' + escapeCssAttrValue(placeholder) + '"]',
        xpath: '//' + tag + '[@placeholder=' + xpathLiteral(placeholder) + ']',
      }, { value: placeholder }));
    }

    var nameAttr = el.getAttribute('name');
    if (nameAttr) {
      candidates.push(mkCandidate(65, 'name', {
        css: tag + '[name="' + escapeCssAttrValue(nameAttr) + '"]',
        xpath: '//' + tag + '[@name=' + xpathLiteral(nameAttr) + ']',
      }, { value: nameAttr }));
    }

    if (TEXT_TAGS.indexOf(tag) !== -1) {
      var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text && text.length <= 60) {
        candidates.push(mkCandidate(55, 'text', { css: null, xpath: textXPath(tag, text) }, { value: text }));
      }
    }

    candidates.push(mkCandidate(10, 'css', { css: buildNthOfTypePath(el), xpath: null }, {}));

    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates;
  }

  function buildSelectorInfo(el) {
    return { candidates: collectCandidates(el) };
  }

  // ---------- overlay panel (top frame only) ----------

  function isInsideOverlay(path) {
    return !!panelHost && path.indexOf(panelHost) !== -1;
  }

  function updatePanelCount() {
    if (countEl) countEl.textContent = actionCount + (actionCount === 1 ? ' action' : ' actions');
  }

  function updatePanelStatus() {
    if (statusEl) statusEl.textContent = paused ? 'Paused' : 'Recording';
    if (assertStateEl) assertStateEl.textContent = 'Assert: ' + (assertMode ? 'on' : 'off');
  }

  function toggleAssertMode() {
    assertMode = !assertMode;
    updatePanelStatus();
  }

  function sendControl(command) {
    try {
      if (window.__wrControl) window.__wrControl(command).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function mountPanel() {
    if (window.top !== window) return;

    var host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.bottom = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';
    panelHost = host;

    function attach() {
      (document.body || document.documentElement).appendChild(host);
      var shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<style>' +
        '.panel{font:12px -apple-system,Segoe UI,Roboto,sans-serif;background:#1e1e1e;color:#eee;' +
        'border-radius:8px;padding:10px 12px;box-shadow:0 2px 12px rgba(0,0,0,.4);min-width:170px;}' +
        '.row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}' +
        '.dot{width:8px;height:8px;border-radius:50%;background:#e33;display:inline-block;margin-right:6px;}' +
        'button{font:inherit;background:#333;color:#eee;border:1px solid #555;border-radius:4px;' +
        'padding:4px 8px;cursor:pointer;margin-left:4px;}' +
        'button:hover{background:#444;}' +
        '#wr-finish{background:#2a6;border-color:#2a6;}' +
        '</style>' +
        '<div class="panel">' +
        '<div class="row"><span><span class="dot"></span><span id="wr-status">Recording</span></span>' +
        '<span id="wr-count">0 actions</span></div>' +
        '<div class="row"><span id="wr-assert-state">Assert: off</span></div>' +
        '<div class="row">' +
        '<button id="wr-pause">Pause</button>' +
        '<button id="wr-assert">Assert</button>' +
        '<button id="wr-finish">Finish</button>' +
        '</div>' +
        '</div>';

      countEl = shadow.getElementById('wr-count');
      statusEl = shadow.getElementById('wr-status');
      assertStateEl = shadow.getElementById('wr-assert-state');

      var pauseBtn = shadow.getElementById('wr-pause');
      pauseBtn.addEventListener('click', function () {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        updatePanelStatus();
      });
      shadow.getElementById('wr-assert').addEventListener('click', function () { toggleAssertMode(); });
      shadow.getElementById('wr-finish').addEventListener('click', function () { sendControl('finish'); });
    }

    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  // ---------- emitting ----------

  function emitAction(action) {
    actionCount++;
    updatePanelCount();
    try {
      if (window.__wrRecordAction) window.__wrRecordAction(action).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function isTextEntryField(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].indexOf(type) === -1;
    }
    return false;
  }

  function getFieldValue(el) {
    return el.value;
  }

  function flushPendingFill() {
    if (!pendingFill) return;
    var el = pendingFill.el;
    var value = pendingFill.value;
    pendingFill = null;
    emitAction({ type: 'fill', selector: buildSelectorInfo(el), value: value, timestamp: Date.now() });
  }

  // ---------- event capture (capture phase on document) ----------

  document.addEventListener('click', function (e) {
    if (paused) return;
    var path = e.composedPath();
    if (isInsideOverlay(path)) return;
    var target = path[0];
    if (!(target instanceof Element)) return;

    if (assertMode) {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey && recordTableAssertion(target)) return;
      recordAssertion(target, e.altKey);
      return;
    }

    if (pendingFill && pendingFill.el !== target) flushPendingFill();

    var tag = target.tagName.toLowerCase();
    var type = (target.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      emitAction({
        type: target.checked ? 'check' : 'uncheck',
        selector: buildSelectorInfo(target),
        timestamp: Date.now(),
      });
    } else {
      emitAction({ type: 'click', selector: buildSelectorInfo(target), timestamp: Date.now() });
    }
  }, true);

  document.addEventListener('input', function (e) {
    if (paused || assertMode) return;
    var path = e.composedPath();
    if (isInsideOverlay(path)) return;
    var target = path[0];
    if (!(target instanceof Element) || !isTextEntryField(target)) return;

    if (pendingFill && pendingFill.el !== target) flushPendingFill();
    pendingFill = { el: target, value: getFieldValue(target) };
  }, true);

  document.addEventListener('focusin', function (e) {
    if (isInsideOverlay(e.composedPath())) return;
    var target = e.composedPath()[0];
    if (pendingFill && pendingFill.el !== target) flushPendingFill();
  }, true);

  document.addEventListener('blur', function (e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (isInsideOverlay(path)) return;
    var target = path[0];
    if (pendingFill && pendingFill.el === target) flushPendingFill();
  }, true);

  document.addEventListener('change', function (e) {
    if (paused) return;
    var path = e.composedPath();
    if (isInsideOverlay(path)) return;
    var target = path[0];
    if (!(target instanceof Element)) return;
    var tag = target.tagName.toLowerCase();

    if (tag === 'select') {
      if (pendingFill && pendingFill.el === target) flushPendingFill();
      var opt = target.options[target.selectedIndex];
      emitAction({
        type: 'selectOption',
        selector: buildSelectorInfo(target),
        value: target.value,
        label: opt ? opt.text : null,
        timestamp: Date.now(),
      });
      return;
    }

    if (tag === 'input' && (target.getAttribute('type') || '').toLowerCase() === 'file') {
      var files = Array.prototype.map.call(target.files || [], function (f) { return f.name; });
      emitAction({ type: 'setInputFiles', selector: buildSelectorInfo(target), files: files, timestamp: Date.now() });
      return;
    }

    if (pendingFill && pendingFill.el === target) flushPendingFill();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (paused) return;
    var path = e.composedPath();
    if (isInsideOverlay(path)) return;

    if (e.key === 'F8') {
      toggleAssertMode();
      return;
    }

    var mapped = KEY_MAP[e.key];
    if (!mapped) return;

    var target = path[0];
    if (!(target instanceof Element)) return;

    if (e.key === 'Enter' && pendingFill && pendingFill.el === target) flushPendingFill();

    emitAction({ type: 'press', selector: buildSelectorInfo(target), key: mapped, timestamp: Date.now() });
  }, true);

  function findTableLikeContainer(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'table') return { root: el, native: true };
    var closestTable = el.closest ? el.closest('table') : null;
    if (closestTable) return { root: closestTable, native: true };
    var childTable = el.querySelector ? el.querySelector('table') : null;
    if (childTable) return { root: childTable, native: true };
    if (el.children && el.children.length > 1) return { root: el, native: false };
    return null;
  }

  function cellText(el) {
    return (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function extractTableData(root, native) {
    var headers = [];
    var rowEls = [];

    if (native) {
      var headerCells = root.querySelectorAll('thead th');
      var firstRow = root.querySelector('tr');
      if (headerCells.length === 0 && firstRow) {
        headerCells = firstRow.querySelectorAll('th');
      }
      headers = Array.prototype.map.call(headerCells, cellText);

      var bodyRows = root.querySelectorAll('tbody tr');
      if (bodyRows.length === 0) {
        bodyRows = root.querySelectorAll('tr');
        if (headers.length > 0 && bodyRows.length > 0 && bodyRows[0].querySelector('th')) {
          bodyRows = Array.prototype.slice.call(bodyRows, 1);
        }
      }
      rowEls = Array.prototype.slice.call(bodyRows);
    } else {
      rowEls = Array.prototype.slice.call(root.children);
    }

    var rows = rowEls.map(function (rowEl) {
      var cellEls = native ? rowEl.querySelectorAll('td, th') : rowEl.children;
      return Array.prototype.map.call(cellEls, cellText);
    });

    return { headers: headers, rows: rows };
  }

  function recordTableAssertion(target) {
    var tableInfo = findTableLikeContainer(target);
    if (!tableInfo) return false;
    var data = extractTableData(tableInfo.root, tableInfo.native);
    emitAction({
      type: 'assertTable',
      selector: buildSelectorInfo(tableInfo.root),
      native: tableInfo.native,
      headers: data.headers,
      rows: data.rows,
      timestamp: Date.now(),
    });
    return true;
  }

  function recordAssertion(el, altKey) {
    if (altKey && isTextEntryField(el)) {
      emitAction({ type: 'assertValue', selector: buildSelectorInfo(el), value: getFieldValue(el), timestamp: Date.now() });
      return;
    }
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text) {
      emitAction({ type: 'assertText', selector: buildSelectorInfo(el), text: text, timestamp: Date.now() });
    } else {
      emitAction({ type: 'assertVisible', selector: buildSelectorInfo(el), timestamp: Date.now() });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
