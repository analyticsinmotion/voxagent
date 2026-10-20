'use strict';

// Checks how lib/ui.js reads keys: a wait reports the key that ended it, Ctrl+C raises
// SIGINT whether or not a key is awaited, the terminal stays in raw mode from the start
// of reading until it is restored, and a key that arrives while no wait is active is
// discarded. A child process reading through a pipe shows the last of these with input
// that the operating system holds until the process reads it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');

const { REPO, lib, helper } = require('../helpers/repo');
const { installFakeStdin } = require('../helpers/fakes');

const ui = require(lib('ui'));

// Resolves with the value a wait's promise resolves with, or with 'pending' when it has
// not settled within SETTLE_MS, so a wait that never ends fails its test rather than
// leaving the run without work.
const SETTLE_MS = 1000;

function settled(promise) {
  let timer;
  const pending = new Promise((resolve) => {
    timer = setTimeout(() => resolve('pending'), SETTLE_MS);
  });

  return Promise.race([promise, pending]).finally(() => clearTimeout(timer));
}

describe('a key wait', () => {
  let terminal;

  beforeEach(() => {
    terminal = installFakeStdin();
  });

  afterEach(() => {
    ui.restoreTerminal();
    terminal.restore();
  });

  const press = (text) => terminal.stdin.emit('data', Buffer.from(text));

  it('reports the key that ended it: ENTER, H, C or any other key', async () => {
    for (const key of ['\r', 'h', 'H', 'c', 'C', 'x', '\x1b[A']) {
      const wait = ui.waitForKey();

      press(key);

      assert.strictEqual(await settled(wait.promise), 'key');
      assert.strictEqual(wait.key, key);
    }
  });

  it('discards a key that arrives while no wait is active, so the next wait ends on the next key', async () => {
    const first = ui.waitForKey();
    press('\r');
    assert.strictEqual(await settled(first.promise), 'key');

    press('c');

    const second = ui.waitForKey();
    let ended = false;
    second.promise.then(() => {
      ended = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(ended, false, 'the key that arrived before the wait began did not end it');

    press('h');

    assert.strictEqual(await settled(second.promise), 'key');
    assert.strictEqual(second.key, 'h');
  });

  it('reads keys from the start of reading, so a key that arrives before the first wait is discarded', async () => {
    ui.startReadingKeys();
    press('\r');

    const wait = ui.waitForKey();
    press('c');

    assert.strictEqual(await settled(wait.promise), 'key');
    assert.strictEqual(wait.key, 'c');
  });

  it('ends a cancelled wait as cancelled, and a cancelled wait takes no later key', async () => {
    const stop = ui.waitForKey();

    stop.cancel();
    assert.strictEqual(await settled(stop.promise), 'cancelled');

    press('\r');
    assert.strictEqual(stop.key, null);

    const next = ui.waitForKey();
    press('h');

    assert.strictEqual(await settled(next.promise), 'key');
    assert.strictEqual(next.key, 'h');
  });

  it('cancels a wait still active when another begins, so one key ends one wait', async () => {
    const earlier = ui.waitForKey();
    const later = ui.waitForKey();

    press('\r');

    assert.strictEqual(await settled(earlier.promise), 'cancelled');
    assert.strictEqual(await settled(later.promise), 'key');
  });

  it('raises SIGINT for Ctrl+C during a wait and while no wait is active, and ends no wait with it', async () => {
    const raised = [];
    const written = [];

    // Presses Ctrl+C with standard output captured and with the test runner's own SIGINT
    // listeners set aside, since the runner reports through standard output and ends the
    // run on SIGINT. Both are put back before the press returns.
    const pressCtrlC = () => {
      const runnerListeners = process.listeners('SIGINT');
      const realWrite = process.stdout.write;
      const onSigint = () => raised.push('SIGINT');

      process.removeAllListeners('SIGINT');
      process.on('SIGINT', onSigint);
      process.stdout.write = (chunk) => {
        written.push(String(chunk));
        return true;
      };

      try {
        press('\x03');
      } finally {
        process.stdout.write = realWrite;
        process.removeListener('SIGINT', onSigint);
        for (const listener of runnerListeners) {
          process.on('SIGINT', listener);
        }
      }
    };

    const wait = ui.waitForKey();

    pressCtrlC();
    assert.deepStrictEqual(raised, ['SIGINT']);

    wait.cancel();
    assert.strictEqual(await settled(wait.promise), 'cancelled');

    pressCtrlC();
    assert.deepStrictEqual(raised, ['SIGINT', 'SIGINT']);
    assert.deepStrictEqual(written, ['\n', '\n']);
  });

  it('puts the terminal in raw mode once, keeps it there between waits, and takes it out when restored', async () => {
    const before = terminal.stdin.listenerCount('data');

    const first = ui.waitForKey();
    press('\r');
    assert.strictEqual(await settled(first.promise), 'key');

    const second = ui.waitForKey();
    second.cancel();

    assert.deepStrictEqual(terminal.stdin.rawModes, [true]);
    assert.strictEqual(terminal.stdin.listenerCount('data'), before + 1);

    ui.restoreTerminal();

    assert.deepStrictEqual(terminal.stdin.rawModes, [true, false]);
    assert.strictEqual(terminal.stdin.listenerCount('data'), before);
  });
});

// Runs test/helpers/keys-child.js and plays the part of the user: ENTER at the prompt,
// C while the child is busy, and H LATE_KEY_MS after the wait at the next prompt
// begins. Resolves with the result the child reports for that last wait.
const LATE_KEY_MS = 300;

function runKeysChild() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    const child = spawn(process.execPath, [helper('keys-child')], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const done = new Set();
    let stdout = '';
    let stderr = '';

    // The child may exit before the late key is written.
    child.stdin.on('error', () => {});

    const step = (name, marker, action) => {
      if (!done.has(name) && stdout.includes(`${marker}\n`)) {
        done.add(name);
        action();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
      step('prompt', 'waiting at the prompt', () => child.stdin.write('\r'));
      step('busy', 'busy', () => child.stdin.write('c'));
      step('next', 'waiting at the next prompt', () => setTimeout(() => child.stdin.write('h'), LATE_KEY_MS));
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('error', reject);
    child.on('close', (status) => {
      const line = stdout.split('\n').find((text) => text.startsWith('{'));
      resolve({ status, result: line ? JSON.parse(line) : null, output: stdout + stderr });
    });
  });
}

describe('a key written while no wait is active, read through a pipe', { timeout: 60000 }, () => {
  it('is discarded, so the wait at the next prompt ends on the key pressed after it began', async () => {
    const run = await runKeysChild();

    assert.strictEqual(run.status, 0, run.output);
    assert.ok(run.result, run.output);
    assert.deepStrictEqual(
      { reason: run.result.reason, key: run.result.key },
      { reason: 'key', key: 'h' },
      `the wait at the next prompt ended ${run.result.afterMs} ms after it began, with the key ${JSON.stringify(run.result.key)}`,
    );
  });
});
