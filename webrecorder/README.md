# webrecorder

A CLI tool that opens a browser, records what a human does on a page, and
compiles that session into runnable test cases (Playwright TypeScript,
Selenium Python/pytest, or a declarative JSON suite).

> **⚠️ Security warning:** if you type a password (or anything else
> sensitive) into a field while recording, it is stored **verbatim, in
> plain text**, in `session.json`. Treat that file like a secret — don't
> commit it, don't share it, and scrub or redact any credentials before
> handing it off or checking it in.

## Install

```sh
cd webrecorder
npm install
```

Dependencies: `playwright` (the recording driver) and `exceljs` (to parse
`.xlsx` downloads — see **Verifying downloaded reports** below).
`exceljs` was picked over the more commonly-suggested `xlsx` (SheetJS)
package: the npm-published `xlsx` carries an unpatched high-severity
prototype-pollution/ReDoS advisory directly in its parsing path (the
exact code this feature would call), while `exceljs`'s only advisory is
moderate-severity, in a `uuid` codepath it doesn't exercise for reading
files.

## Usage

### 1. Record a session

```sh
node src/cli.js record --url https://example.com/login --out session.json
```

This launches a headed Chromium browser with a floating recorder panel in
the bottom-right corner. Interact with the page normally:

- Clicks, checkbox/radio toggles, text input, `<select>` changes, file
  picks, and Enter/Escape/Tab/Arrow key presses are all captured.
- Typing into a field is buffered into a single `fill` action (flushed on
  blur, `change`, Enter, or when you move focus elsewhere) — not one
  action per keystroke.
- Navigations caused by your interactions are detected automatically and
  marked `implicit`, with a check for the resulting URL generated for
  free (`toHaveURL` in Playwright, `EC.url_to_be` in Selenium). This is
  generic — it fires on *any* click or key press followed by a
  navigation within 3 seconds, not just navbar links. A `<button
  onclick="...">` that redirects, a form submit, or a client-side route
  change (`history.pushState`) are all caught the same way as a plain
  `<a href>`.

**Assert mode** — press `F8` or click "Assert" in the panel to toggle it.
While on, clicks don't perform the click — they record an assertion
instead:

- `Alt`+click a field → assert its value
- `Ctrl`+click any cell/row inside a table (or a table-like container) →
  assert the **whole table's contents**. This walks the nearest `<table>`
  (or, if there isn't one, the clicked container's direct children as
  rows/columns), records every row's cell text, and ties it to the
  table's own selector. Use this for things like an AWB search result
  grid: type the barcode, click Search, wait for the results to render,
  then `Ctrl`+click a cell in the table to snapshot the whole result set
  into the test.
- click an element with text → assert its text
- click anything else → assert it's visible

Click **Finish** in the panel (or press Ctrl+C in the terminal) to stop
recording and write `session.json`.

**Downloads** — click a "Download Report" button and the resulting file
is captured automatically, no special gesture needed: the browser
download is saved (to a `downloads/` folder next to `session.json`),
and if it's a `.csv` or `.xlsx` file, its headers and every row are
parsed and recorded too. See **Verifying downloaded reports** below for
what that turns into in each output format.

Pass `--headless` to run without a visible browser window (useful in CI
or headless environments — you'll need to drive interactions
programmatically in that case, since there's no window to click in).

### 2. Generate a test

```sh
node src/cli.js gen --in session.json --format playwright --out login.spec.ts
node src/cli.js gen --in session.json --format selenium --out test_login.py
node src/cli.js gen --in session.json --format json --out suite.json
```

Or generate all three at once:

```sh
node src/cli.js gen-all --in session.json --outdir tests --name "login flow"
```

This writes `tests/test.spec.ts`, `tests/test_recorded.py`, and
`tests/suite.json`.

## How selectors work

For every recorded element, `webrecorder` builds a ranked list of
selector candidates (test ids, id, ARIA role + accessible name,
associated label, placeholder, name attribute, exact text, and a
`nth-of-type` CSS path as a last resort). Each candidate is verified for
uniqueness in the live DOM at record time; non-unique candidates are
scored down. The generators pick the best candidate for each target
format — native Playwright locators (`getByTestId`, `getByRole`, etc.)
for the Playwright output, and a CSS-or-XPath locator for Selenium (which
has no role/label locators). The JSON suite keeps the full ranked
candidate chain (`primary` + up to 3 `fallbacks`) per step, intended as
input to a future self-healing selector resolver.

IDs that look auto-generated (React's `:r0:`-style ids, long hex
fragments, or ids prefixed by common component libraries like `mui-`,
`radix-`, `headlessui-`, `ember-`) are never used as selectors, since
they tend to change between runs/builds.

## Verifying downloaded reports

Clicking a button that downloads a file (a "Download Report" button, an
export link, whatever) is captured as a `download` action, paired with
the click that triggered it — no extra recording step required. If the
file is `.csv` or `.xlsx`, its headers and rows are parsed at record
time and become part of the expected data:

- **Playwright**: the click and `page.waitForEvent('download')` are
  combined into one `Promise.all(...)` (required so the listener is
  armed before the click fires — waiting for the event only after the
  click can miss it). The file is then read back with an inlined
  `readTabularDownload()` helper (CSV needs no dependency; `.xlsx` needs
  `exceljs` installed in *your* test project) and its headers/rows are
  asserted with `toEqual`.
- **Selenium**: the `driver` fixture is extended to set a temp download
  directory via Chrome prefs. After the click, a small polling helper
  waits for a new file to land there, then `read_tabular_file()` (stdlib
  `csv` for `.csv`, `openpyxl` — `pip install openpyxl` — for `.xlsx`)
  reads and compares it.
- **JSON suite**: a `download` step with `suggestedFilename`, `headers`,
  and `rows` (rows keyed by header, same convention as `assertTable`).
  It has no element `selector` — there's no DOM element to point at,
  just a file.

One thing worth knowing: a very common vanilla-JS download pattern is
to create a hidden `<a>`, click it via JS, then remove it — which fires
a *second*, synthetic click event a few milliseconds after your real
click on the visible button. The recorder detects this (clicks within
50ms of each other immediately before a download are treated as one
burst) and pairs the download with the real, visible button — the
throwaway synthetic click is dropped rather than becoming a broken step
that points at an element which no longer exists on replay.

## Project layout

```
webrecorder/
  src/cli.js            # arg parsing, subcommands (record / gen / gen-all)
  src/recorder.js        # launches the browser, collects the action stream, writes session.json
  src/injected.js         # runs IN the recorded page: selector engine + event capture + overlay panel
  src/generators.js      # session.json -> Playwright / Selenium / JSON test code
  test/                  # fixture session.json + generator tests (no browser needed),
                          # headless behavioral tests for injected.js/recorder.js/downloads
                          # (needs Chromium)
```

`session.json` is the stable contract between recording and generation —
the generators never touch a browser.

## Running the tests

```sh
node test/generators.test.js   # generator output sanity checks, no browser
node test/injected.test.js     # behavioral checks against a real headless Chromium
node test/recorder.test.js     # navigate-detection checks against a real headless Chromium
node test/downloads.test.js    # real CSV/XLSX download capture + parsing, against a real headless Chromium
```
