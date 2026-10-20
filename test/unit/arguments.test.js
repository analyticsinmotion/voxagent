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
  it('declares exactly ten options, and USAGE lists each one and no other', () => {
    const declared = Object.keys(cli.OPTIONS).sort();
    const printed = [...new Set(cli.USAGE.match(/--[a-z-]+/g))].map((flag) => flag.slice(2)).sort();
    const shorts = Object.values(cli.OPTIONS).filter((spec) => spec.short).map((spec) => `-${spec.short}`);

    assert.deepStrictEqual(declared, ['context', 'debug', 'denoise', 'device', 'file', 'help', 'list-devices', 'memory', 'model', 'version']);
    assert.deepStrictEqual(printed, declared);
    assert.deepStrictEqual(shorts.sort(), ['-h', '-v']);

    for (const short of shorts) {
      assert.ok(cli.USAGE.includes(`, ${short} `), `USAGE lists ${short}`);
    }
  });

  it('describes voxagent in one line after the usage line', () => {
    assert.strictEqual(cli.USAGE.trim().split('\n')[2], 'Voice-powered terminal agent.');
  });

  it('describes --file as answering one question recorded in an audio file, then exiting', () => {
    const line = cli.USAGE.split('\n').find((text) => text.trimStart().startsWith('--file'));
    assert.strictEqual(line, '  --file <path>             Answer one question recorded in an audio file, then exit');
  });

  it('lists --memory and --context after --model, each description starting in column 29', () => {
    const lines = cli.USAGE.split('\n');
    const at = lines.findIndex((text) => text.trimStart().startsWith('--model'));

    assert.deepStrictEqual(lines.slice(at + 1, at + 3), [
      '  --memory                  Keep the conversation for follow-up questions until voxagent exits',
      '  --context <n>             Number of recent exchanges --memory keeps, 1 to 50 (default: 10)',
    ]);

    for (const line of lines.filter((text) => text.startsWith('  --'))) {
      assert.match(line, /^ {2}\S.{25}\S/, line);
      assert.strictEqual(line[27], ' ', line);
    }
  });
});

describe('--memory and --context', () => {
  const parse = (...args) => {
    const settings = cli.parseCommandLine(['node', 'voxagent', ...args]);
    return { memory: settings.memory, context: settings.context };
  };

  it('keeps no conversation by default', () => {
    assert.strictEqual(parse().memory, false);
  });

  it('keeps 10 exchanges with --memory alone', () => {
    assert.deepStrictEqual(parse('--memory'), { memory: true, context: 10 });
  });

  it('accepts --context from 1 to 50 with --memory, in either order and with =', () => {
    assert.deepStrictEqual(parse('--memory', '--context', '1'), { memory: true, context: 1 });
    assert.deepStrictEqual(parse('--memory', '--context', '50'), { memory: true, context: 50 });
    assert.deepStrictEqual(parse('--context', '7', '--memory'), { memory: true, context: 7 });
    assert.deepStrictEqual(parse('--memory', '--context=25'), { memory: true, context: 25 });
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

  const contextCases = [
    ['--context with no value', ['--memory', '--context']],
    ['--context followed by another option', ['--context', '--memory']],
    ['--context= with an empty value', ['--memory', '--context=']],
    ['--context abc', ['--memory', '--context', 'abc']],
    ['--context 0', ['--memory', '--context', '0']],
    ['--context 51', ['--memory', '--context', '51']],
    ['--context 2.5', ['--memory', '--context', '2.5']],
    ['--context -1', ['--memory', '--context', '-1']],
    ['--context=-1', ['--memory', '--context=-1']],
    ['--context 4096', ['--memory', '--context', '4096']],
  ];

  for (const [label, args] of contextCases) {
    it(`${label} exits 2 saying --context takes a number of exchanges from 1 to 50, with the help hint`, async () => {
      const { run, attempts } = await runBlocked(args);

      assert.strictEqual(run.status, 2, describeRun(run));
      assert.deepStrictEqual(run.lines, ["Error: Option '--context' takes a number of exchanges from 1 to 50.", HINT]);
      assert.deepStrictEqual(attempts, []);
    });
  }

  it('--context without --memory exits 2 saying it requires --memory, with the help hint', async () => {
    for (const args of [['--context', '5'], ['--file', 'question.wav', '--context', '5']]) {
      const { run, attempts } = await runBlocked(args);

      assert.strictEqual(run.status, 2, describeRun(run));
      assert.deepStrictEqual(run.lines, ["Error: Option '--context' requires '--memory'.", HINT]);
      assert.deepStrictEqual(attempts, []);
    }
  });

  it('--file with --memory exits 2 saying the two cannot be combined, with the help hint', async () => {
    const { run, attempts } = await runBlocked(['--file', 'question.wav', '--memory']);

    assert.strictEqual(run.status, 2, describeRun(run));
    assert.deepStrictEqual(run.lines, ["Error: Options '--file' and '--memory' cannot be combined.", HINT]);
    assert.deepStrictEqual(attempts, []);
  });

  it('--memory with a value exits 2 with one line naming the problem and the help hint', async () => {
    const { run, attempts } = await runBlocked(['--memory=yes']);

    assert.strictEqual(run.status, 2, describeRun(run));
    assert.deepStrictEqual(run.lines, ["Error: Option '--memory' does not take an argument", HINT]);
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
