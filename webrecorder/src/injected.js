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
  var FORM_CONTROL_TAGS = ['input', 'select', 'textarea'];
  var KEY_MAP = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };

  var paused = false;
  var assertMode = false;
  var pendingFill = null; // { el, value }
  var actionCount = 0;
  var panelHost = null;
  var countEl = null;
  var statusEl = null;
  var assertStateEl = null;

  // ---------- string helpers ----------

  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // innerText is what the user sees (and what Selenium's .text / Playwright's
  // useInnerText compare against); textContent also includes hidden text.
  function visibleText(el) {
    var t = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return normText(t);
  }

  function escapeCssAttrValue(v) {
    return String(v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\a ')
      .replace(/\r/g, '');
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

  function attrLocator(tag, attr, value) {
    return {
      css: tag + '[' + attr + '="' + escapeCssAttrValue(value) + '"]',
      xpath: '//' + tag + '[@' + attr + '=' + xpathLiteral(value) + ']',
    };
  }

  function textXPath(tag, text) {
    return '//' + tag + '[normalize-space(.)=' + xpathLiteral(text) + ']';
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

  function isFormControl(el) {
    return FORM_CONTROL_TAGS.indexOf(el.tagName.toLowerCase()) !== -1;
  }

  // Returns { text, wrapped } — wrapped is true when the control sits inside
  // the <label> (vs. being referenced via label[for]).
  function getAssociatedLabel(el) {
    if (!isFormControl(el)) return null;
    if (el.id) {
      try {
        var label = document.querySelector('label[for="' + escapeCssAttrValue(el.id) + '"]');
        if (label) {
          var t1 = normText(label.textContent);
          if (t1) return { text: t1, wrapped: false };
        }
      } catch (e) { /* malformed id */ }
    }
    var ancestor = el.closest ? el.closest('label') : null;
    if (ancestor) {
      var t2 = normText(ancestor.textContent);
      if (t2) return { text: t2, wrapped: true };
    }
    return null;
  }

  // Returns { name, source } so the concrete CSS/XPath for a role candidate
  // can be built from wherever the name actually came from.
  function computeAccessibleName(el) {
    var ariaLabel = normText(el.getAttribute('aria-label'));
    if (ariaLabel) return { name: ariaLabel, source: 'aria-label' };

    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var joined = labelledBy.split(/\s+/).map(function (id) {
        var ref = document.getElementById(id);
        return ref ? normText(ref.textContent) : '';
      }).filter(Boolean).join(' ');
      if (joined) return { name: joined, source: 'aria-labelledby' };
    }

    var label = getAssociatedLabel(el);
    if (label) return { name: label.text, source: 'label' };

    var tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      var alt = normText(el.getAttribute('alt'));
      if (alt) return { name: alt, source: 'alt' };
    }

    if (tag === 'input') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if ((type === 'submit' || type === 'button') && normText(el.value)) {
        return { name: normText(el.value), source: 'value' };
      }
    }

    var placeholder = normText(el.getAttribute('placeholder'));
    if (placeholder) return { name: placeholder, source: 'placeholder' };
    var title = normText(el.getAttribute('title'));
    if (title) return { name: title, source: 'title' };

    var text = normText(el.textContent);
    if (text && text.length <= 80) return { name: text, source: 'text' };

    // Icon-only buttons/links: the name comes from the image inside.
    var img = el.querySelector ? el.querySelector('img[alt]') : null;
    if (img && normText(img.getAttribute('alt'))) {
      return { name: normText(img.getAttribute('alt')), source: 'img-alt' };
    }

    return null;
  }

  // ---------- concrete locator builders ----------

  function buildLabelLocator(el, label) {
    var tag = el.tagName.toLowerCase();
    var lit = xpathLiteral(label.text);
    if (label.wrapped) {
      return { css: null, xpath: '//label[normalize-space(.)=' + lit + ']//' + tag };
    }
    // Resolve through the label's for= attribute. (A following::/preceding::
    // union would match two elements, and find_element would then return the
    // preceding one — the wrong field.)
    return { css: null, xpath: '//' + tag + '[@id=//label[normalize-space(.)=' + lit + ']/@for]' };
  }

  function buildRoleLocator(el, acc) {
    var tag = el.tagName.toLowerCase();
    var name = acc.name;
    switch (acc.source) {
      case 'aria-label':
        return attrLocator(tag, 'aria-label', el.getAttribute('aria-label'));
      case 'aria-labelledby':
        return attrLocator(tag, 'aria-labelledby', el.getAttribute('aria-labelledby'));
      case 'label':
        return buildLabelLocator(el, getAssociatedLabel(el));
      case 'alt':
        return attrLocator(tag, 'alt', el.getAttribute('alt'));
      case 'value':
        return attrLocator(tag, 'value', el.value);
      case 'placeholder':
        return attrLocator(tag, 'placeholder', el.getAttribute('placeholder'));
      case 'title':
        return attrLocator(tag, 'title', el.getAttribute('title'));
      case 'img-alt':
        return { css: null, xpath: '//' + tag + '[.//img[@alt=' + xpathLiteral(name) + ']]' };
      default:
        return { css: null, xpath: textXPath(tag, name) };
    }
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

  // Uniqueness is checked against the element's own root (document or shadow
  // root). Querying the document for something inside a shadow root would
  // always report zero matches and penalize every candidate. XPath cannot
  // reach into shadow roots at all, so those candidates stay penalized.
  function checkUniqueness(el, css, xpath) {
    var root = el.getRootNode ? el.getRootNode() : document;
    try {
      if (css) {
        if (!root.querySelectorAll) return false;
        return root.querySelectorAll(css).length === 1;
      }
      if (xpath) {
        if (root !== document) return false;
        var res = document.evaluate('count(' + xpath + ')', document, null, XPathResult.NUMBER_TYPE, null);
        return res.numberValue === 1;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function mkCandidate(el, score, engine, locators, extra) {
    var unique = checkUniqueness(el, locators.css, locators.xpath);
    var candidate = {
      score: unique ? score : score - 25,
      engine: engine,
      css: locators.css || null,
      xpath: locators.xpath || null,
    };
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
        candidates.push(mkCandidate(el, 100, 'testid', {
          css: '[' + attr + '="' + escapeCssAttrValue(v) + '"]',
          xpath: '//*[@' + attr + '=' + xpathLiteral(v) + ']',
        }, { attr: attr, value: v }));
        break;
      }
    }

    if (el.id && !isGeneratedId(el.id)) {
      candidates.push(mkCandidate(el, 90, 'id', {
        css: '#' + CSS.escape(el.id),
        xpath: '//*[@id=' + xpathLiteral(el.id) + ']',
      }, { value: el.id }));
    }

    var role = getRole(el);
    var acc = computeAccessibleName(el);
    if (role && acc) {
      candidates.push(mkCandidate(el, 80, 'role', buildRoleLocator(el, acc), { role: role, name: acc.name }));
    }

    var label = getAssociatedLabel(el);
    if (label) {
      candidates.push(mkCandidate(el, 78, 'label', buildLabelLocator(el, label), { name: label.text }));
    }

    var placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      candidates.push(mkCandidate(el, 70, 'placeholder', attrLocator(tag, 'placeholder', placeholder), { value: placeholder }));
    }

    var nameAttr = el.getAttribute('name');
    if (nameAttr) {
      candidates.push(mkCandidate(el, 65, 'name', attrLocator(tag, 'name', nameAttr), { value: nameAttr }));
    }

    if (TEXT_TAGS.indexOf(tag) !== -1) {
      var text = normText(el.textContent);
      if (text && text.length <= 60) {
        candidates.push(mkCandidate(el, 55, 'text', { css: null, xpath: textXPath(tag, text) }, { value: text }));
      }
    }

    candidates.push(mkCandidate(el, 10, 'css', { css: buildNthOfTypePath(el), xpath: null }, {}));

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
    // !important so page stylesheets can't reposition or hide the panel.
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('bottom', '16px', 'important');
    host.style.setProperty('right', '16px', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');
    panelHost = host;

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

    // Attach to <html>, not <body>: SPAs that do body.innerHTML = ... on boot
    // would wipe the panel. Re-attach if anything removes it anyway.
    document.documentElement.appendChild(host);
    try {
      new MutationObserver(function () {
        if (!host.isConnected) document.documentElement.appendChild(host);
      }).observe(document.documentElement, { childList: true });
    } catch (e) { /* ignore */ }
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

  function isCheckable(el) {
    if (!el || el.tagName.toLowerCase() !== 'input') return false;
    var type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
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
    // Programmatic clicks (element.click() from page JS) are side effects of
    // something the user already did — a hidden file input clicked by an
    // "Upload" button, a throwaway <a> clicked to start a download. Replaying
    // them fails (the element is hidden or gone), so never record them.
    if (!e.isTrusted) return;
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

    // Clicking a <label> for a checkbox/radio makes the browser dispatch a
    // second click on the control itself; that one records the check/uncheck.
    var label = target.closest ? target.closest('label') : null;
    if (label && !isCheckable(target) && isCheckable(label.control)) return;

    if (pendingFill && pendingFill.el !== target) flushPendingFill();

    if (isCheckable(target)) {
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
    pendingFill = { el: target, value: target.value };
  }, true);

  document.addEventListener('focusin', function (e) {
    var path = e.composedPath();
    if (isInsideOverlay(path)) return;
    if (pendingFill && pendingFill.el !== path[0]) flushPendingFill();
  }, true);

  document.addEventListener('blur', function (e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (isInsideOverlay(path)) return;
    if (pendingFill && pendingFill.el === path[0]) flushPendingFill();
  }, true);

  document.addEventListener('change', function (e) {
    if (paused || assertMode) return;
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
        label: opt ? normText(opt.text) : null,
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
    if (assertMode) return;

    var mapped = KEY_MAP[e.key];
    if (!mapped) return;

    var target = path[0];
    if (!(target instanceof Element)) return;

    // Whatever was typed happened before the key press; keep that order.
    if (pendingFill && pendingFill.el === target) flushPendingFill();

    emitAction({ type: 'press', selector: buildSelectorInfo(target), key: mapped, timestamp: Date.now() });
  }, true);

  // ---------- assertions ----------

  var ARIA_GRID_SEL = '[role="table"], [role="grid"], [role="treegrid"]';
  var ARIA_CELL_SEL = '[role="cell"], [role="gridcell"], [role="rowheader"]';

  function hasElementChildren(el) {
    return !!(el.children && el.children.length);
  }

  // A div-based grid: an ancestor whose children are same-tag "rows" that in
  // turn contain "cells". Starting from a clicked cell, the row itself fails
  // (cells have no element children) and the walk continues up to the grid.
  function looksLikeRowContainer(el) {
    var kids = el.children;
    if (!kids || kids.length < 2) return false;
    var withChildren = 0;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName !== kids[0].tagName) return false;
      if (hasElementChildren(kids[i])) withChildren++;
    }
    return withChildren * 2 >= kids.length;
  }

  function findTableLikeContainer(el) {
    var table = el.closest ? el.closest('table') : null;
    if (table) return { root: table, kind: 'table' };
    var childTable = el.querySelector ? el.querySelector('table') : null;
    if (childTable) return { root: childTable, kind: 'table' };

    var grid = el.closest ? el.closest(ARIA_GRID_SEL) : null;
    if (grid) return { root: grid, kind: 'aria' };
    var childGrid = el.querySelector ? el.querySelector(ARIA_GRID_SEL) : null;
    if (childGrid) return { root: childGrid, kind: 'aria' };

    var node = el;
    while (node && node !== document.body && node.nodeType === 1) {
      if (looksLikeRowContainer(node)) return { root: node, kind: 'children' };
      node = node.parentElement;
    }
    return null;
  }

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  // Child (:scope >) selectors keep nested tables' rows/cells out of the
  // parent's data. Browsers insert an implicit <tbody>, so `:scope > tbody >
  // tr` works even when the markup has none.
  function extractTableData(root, kind) {
    var headers = [];
    var headerRowInBody = false;
    var rowEls;
    var cellsOf;

    if (kind === 'table') {
      headers = toArray(root.querySelectorAll(':scope > thead > tr > th')).map(visibleText);
      rowEls = toArray(root.querySelectorAll(':scope > tbody > tr'));
      if (!headers.length && rowEls.length && rowEls[0].querySelector(':scope > th') && !rowEls[0].querySelector(':scope > td')) {
        headers = toArray(rowEls[0].querySelectorAll(':scope > th')).map(visibleText);
        rowEls = rowEls.slice(1);
        headerRowInBody = true;
      }
      cellsOf = function (row) { return toArray(row.querySelectorAll(':scope > td, :scope > th')); };
    } else if (kind === 'aria') {
      var allRows = toArray(root.querySelectorAll('[role="row"]'));
      var headerRow = null;
      rowEls = [];
      for (var i = 0; i < allRows.length; i++) {
        if (allRows[i].querySelector('[role="columnheader"]')) {
          if (!headerRow) headerRow = allRows[i];
        } else {
          rowEls.push(allRows[i]);
        }
      }
      if (headerRow) headers = toArray(headerRow.querySelectorAll('[role="columnheader"]')).map(visibleText);
      cellsOf = function (row) { return toArray(row.querySelectorAll(ARIA_CELL_SEL)); };
    } else {
      rowEls = toArray(root.children);
      cellsOf = function (row) { return toArray(row.children); };
    }

    var rows = rowEls.map(function (row) { return cellsOf(row).map(visibleText); });
    return { headers: headers, rows: rows, headerRowInBody: headerRowInBody };
  }

  function recordTableAssertion(target) {
    var tableInfo = findTableLikeContainer(target);
    if (!tableInfo) return false;
    var data = extractTableData(tableInfo.root, tableInfo.kind);
    emitAction({
      type: 'assertTable',
      selector: buildSelectorInfo(tableInfo.root),
      kind: tableInfo.kind,
      headerRowInBody: data.headerRowInBody,
      headers: data.headers,
      rows: data.rows,
      timestamp: Date.now(),
    });
    return true;
  }

  function recordAssertion(el, altKey) {
    if (altKey && isTextEntryField(el)) {
      emitAction({ type: 'assertValue', selector: buildSelectorInfo(el), value: el.value, timestamp: Date.now() });
      return;
    }
    var text = visibleText(el);
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
