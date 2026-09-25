'use strict';

// Checks the ways voxagent can end. The microphone is released on every exit path
// a Node process can run by itself: an emitted SIGINT, SIGTERM or SIGBREAK, an
// uncaught exception, and a normal exit. Input that is not a terminal, without
// --file, ends at once with a message and loads nothing.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BIN, REPO, helper } = require('../helpers/repo');
const { runNode, describeRun } = require('../helpers/run');

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-exit-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('releasing the microphone', { timeout: 120000 }, () => {
  const paths = [
    ['an emitted SIGINT, which is how Ctrl+C arrives in raw mode', 'sigint', 0],
    ['an emitted SIGTERM', 'sigterm', 0],
    ['an emitted SIGBREAK', 'sigbreak', 0],
    ['an uncaught exception', 'uncaught', 1],
    ['a normal exit', 'exit', 0],
  ];

  for (const [label, mode, code] of paths) {
    it(`stops the open microphone on ${label}`, async () => {
      const log = path.join(dir, `${mode}.log`);
      const run = await runNode([helper('cleanup-child'), mode, log], { cwd: REPO });
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);

      assert.deepStrictEqual(lines, [`trigger ${mode}`, 'stop'], describeRun(run));
      assert.strictEqual(run.status, code, describeRun(run));
    });
  }
});

describe('input that is not a terminal', { timeout: 120000 }, () => {
  it('without --file, exits 1 with the message and loads no model and no native module', async () => {
    const log = path.join(dir, 'native.log');
    const run = await runNode([BIN], {
      preload: [helper('block-native')],
      env: { VOXAGENT_TEST_NATIVE_LOG: log },
      cwd: REPO,
      input: '\n\n',
    });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [
      'Error: voxagent needs an interactive terminal.',
      'Run it in a terminal rather than with input redirected or piped.',
    ]);
    assert.strictEqual(fs.existsSync(log), false, 'no native module load was attempted');
  });
});
