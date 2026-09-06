#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function usage() {
  console.log(`webrecorder - record browser actions and generate test code

Usage:
  webrecorder record --url <url> --out <session.json>
  webrecorder gen --in <session.json> --format <playwright|selenium|json> [--out <file>]
  webrecorder gen-all --in <session.json> --outdir <dir> [--name <test name>]
`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === 'record') {
    if (!args.url || !args.out) {
      console.error('record requires --url and --out');
      process.exit(1);
    }
    const { record } = require('./recorder');
    await record({ url: args.url, out: args.out, headless: !!args.headless });
    return;
  }

  if (command === 'gen') {
    if (!args.in || !args.format) {
      console.error('gen requires --in and --format');
      process.exit(1);
    }
    const generators = require('./generators');
    if (!generators[toGeneratorKey(args.format)]) {
      console.error(`unknown format: ${args.format} (expected playwright, selenium, or json)`);
      process.exit(1);
    }
    const session = JSON.parse(fs.readFileSync(args.in, 'utf8'));
    const testName = args.name || 'recorded session';
    const code = generators[toGeneratorKey(args.format)](session, { testName });
    if (args.out) {
      fs.writeFileSync(args.out, code);
      console.log(`Wrote ${args.out}`);
    } else {
      process.stdout.write(code);
    }
    return;
  }

  if (command === 'gen-all') {
    if (!args.in || !args.outdir) {
      console.error('gen-all requires --in and --outdir');
      process.exit(1);
    }
    const generators = require('./generators');
    const session = JSON.parse(fs.readFileSync(args.in, 'utf8'));
    const testName = args.name || 'recorded session';
    fs.mkdirSync(args.outdir, { recursive: true });

    const outputs = [
      { format: 'playwright', file: 'test.spec.ts' },
      { format: 'selenium', file: 'test_recorded.py' },
      { format: 'json', file: 'suite.json' },
    ];
    for (const { format, file } of outputs) {
      const code = generators[toGeneratorKey(format)](session, { testName });
      const outPath = path.join(args.outdir, file);
      fs.writeFileSync(outPath, code);
      console.log(`Wrote ${outPath}`);
    }
    return;
  }

  usage();
  process.exit(command ? 1 : 0);
}

function toGeneratorKey(format) {
  return { playwright: 'playwright', selenium: 'seleniumPython', json: 'jsonSuite' }[format];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
