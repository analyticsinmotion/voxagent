'use strict';

// Checks the command line: the declared options against the usage text, every
// argument mistake, --help and --version with native modules unloadable, and the
// options that cannot be combined. Every run loads bin/voxagent.js with native
// module loading blocked and records any attempt, so each run also shows it loads
// no native module.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BIN, REPO, helper } = require('../helpers/repo');
const { runNode, describeRun } = require('../helpers/run');

const cli = require(BIN);

const HINT = 'Run voxagent --help for usage.';

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-arguments-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let runs = 0;

// Runs bin/voxagent.js with native module loading blocked. Returns the run and the
// native modules it tried to load.
async function runBlocked(args, options) {
  const log = path.join(dir, `native-${runs++}.log`);
  const run = await runNode([BIN, ...args], {
    preload: [helper('block-native')],
    env: { VOXAGENT_TEST_NATIVE_LOG: log },
    cwd: REPO,
    ...options,
  });
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { run, attempts };
}

describe('declared options and the usage text', () => {
  it('declares exactly eight options, and USAGE lists each one and no other', () => {
    const declared = Object.keys(cli.OPTIONS).sort();
    const printed = [...new Set(cli.USAGE.match(/--[a-z-]+/g))].map((flag) => flag.slice(2)).sort();
    const shorts = Object.values(cli.OPTIONS).filter((spec) => spec.short).map((spec) => `-${spec.short}`);

    assert.deepStrictEqual(declared, ['debug', 'denoise', 'device', 'file', 'help', 'list-devices', 'model', 'version']);
    assert.deepStrictEqual(printed, declared);
    assert.deepStrictEqual(shorts.sort(), ['-h', '-v']);

    for (const short of shorts) {
      assert.ok(cli.USAGE.includes(`, ${short} `), `USAGE lists ${short}`);
    }
  });

  it('describes --file as answering one question recorded in an audio file, then exiting', () => {
    const line = cli.USAGE.split('\n').find((text) => text.trimStart().startsWith('--file'));
    assert.strictEqual(line, '  --file <path>             Answer one question recorded in an audio file, then exit');
  });
});

describe('argument mistakes', { timeout: 120000 }, () => {
  const cases = [
    ['an unknown option', ['--modle', 'mistral']],
    ['an unknown short option', ['-x']],
    ['--model with no value', ['--model']],
    ['--model followed by another option', ['--model', '--debug']],
    ['--device with no value', ['--device']],
    ['--file with no value', ['--file']],
    ['a stray positional argument', ['hello']],
    ['--model= with an empty value', ['--model=']],
    ['--model=-x with a value that starts with a hyphen', ['--model=-x']],
    ['--file= with an empty value', ['--file=']],
  ];

  for (const [label, args] of cases) {
    it(`${label} exits 2 with one line naming the problem and the help hint`, async () => {
      const { run, attempts } = await runBlocked(args);

      assert.strictEqual(run.status, 2, describeRun(run));
      assert.strictEqual(run.lines.length, 2, describeRun(run));
      assert.match(run.lines[0], /^Error: /);
      assert.strictEqual(run.lines[1], HINT);
      assert.deepStrictEqual(attempts, []);
    });
  }

  it('--file with --device exits 2 saying the two cannot be combined, with the help hint', async () => {
    const { run, attempts } = await runBlocked(['--file', 'question.wav', '--device', 'Microphone']);

    assert.strictEqual(run.status, 2, describeRun(run));
    assert.deepStrictEqual(run.lines, ["Error: Options '--file' and '--device' cannot be combined.", HINT]);
    assert.deepStrictEqual(attempts, []);
  });
});

describe('--help and --version', { timeout: 120000 }, () => {
  it('--help prints the usage and exits 0 with native modules unloadable', async () => {
    const { run, attempts } = await runBlocked(['--help']);

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.strictEqual(run.stdout.trim(), cli.USAGE.trim());
    assert.deepStrictEqual(attempts, []);
  });

  it('--version prints the version in package.json and exits 0 with native modules unloadable', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const { run, attempts } = await runBlocked(['--version']);

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.strictEqual(run.stdout.trim(), pkg.version);
    assert.deepStrictEqual(attempts, []);
  });

  it('the blocked loader records an attempt when a native module is loaded, which --list-devices does', async () => {
    const { run, attempts } = await runBlocked(['--list-devices']);

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.ok(attempts.length > 0, 'a native module load was attempted and recorded');
  });
});
