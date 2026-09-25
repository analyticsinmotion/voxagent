'use strict';

// Transcribes the committed fixture with the real whisper addon and the real model,
// in the model's default location, through the transcription child. Also checks
// that whisper's own output stays hidden, and that a model that cannot be loaded
// is reported as a failure by a child that never loaded the good one. Runs when
// VOXAGENT_INTEGRATION includes transcription; the model is downloaded if absent.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FIXTURE, FIXTURE_TEXT, lib } = require('../helpers/repo');
const { skipUnless } = require('../helpers/integration');
const { readWavPayload } = require('../helpers/wav');

// Counts the children lib/whisper.js forks. It takes fork from child_process as
// it loads, so this is in place before it is required.
let forks = 0;
const realFork = childProcess.fork;

childProcess.fork = function countingFork(...args) {
  forks += 1;
  return realFork.apply(this, args);
};

const whisper = require(lib('whisper'));
const { ensureModel } = require(lib('model'));

// Replaces the process's own standard stream writes for the length of fn, and
// collects every write, passing each one through as well.
async function collectWrites(fn) {
  const writes = [];
  const real = { out: process.stdout.write, err: process.stderr.write };

  const collect = (stream, name) => function write(chunk, ...rest) {
    writes.push(String(chunk));
    return real[name].call(stream, chunk, ...rest);
  };

  process.stdout.write = collect(process.stdout, 'out');
  process.stderr.write = collect(process.stderr, 'err');

  try {
    await fn();
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }

  return writes.join('');
}

describe('transcription with the real whisper model', { skip: skipUnless('transcription'), timeout: 20 * 60 * 1000 }, () => {
  const audio = readWavPayload(FIXTURE);
  let modelPath;
  let dir;

  before(async () => {
    modelPath = await ensureModel();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-transcription-'));
  });

  after(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('transcribes the fixture to exactly the question, twice, with the model loaded once in one child', async () => {
    const forksBefore = forks;
    const texts = [];
    let host;

    // With --debug the child's output is shown, which is where the model load is
    // reported. The addon keeps one model context for the life of the process, so
    // one child reporting one load means the model was read once.
    const shown = await collectWrites(async () => {
      host = whisper.start({ debug: true });

      try {
        await host.ready();
        await host.loadModel(modelPath);
        texts.push(await host.transcribe(audio, modelPath, false));
        texts.push(await host.transcribe(audio, modelPath, false));
      } finally {
        host.stop();
      }
    });

    assert.deepStrictEqual(texts, [FIXTURE_TEXT, FIXTURE_TEXT]);
    assert.strictEqual(forks - forksBefore, 1);
    assert.strictEqual(shown.split('loading model from').length - 1, 1, shown);
  });

  it('shows nothing whisper writes in ordinary use', async () => {
    let text;

    const shown = await collectWrites(async () => {
      const host = whisper.start({ debug: false });

      try {
        await host.ready();
        await host.loadModel(modelPath);
        text = await host.transcribe(audio, modelPath, false);
      } finally {
        host.stop();
      }
    });

    assert.strictEqual(text, FIXTURE_TEXT);
    assert.ok(!/whisper_|using audio buffer/.test(shown), shown);
  });

  it('reports a model that cannot be loaded as a failure, in a child that never loaded the good model', async () => {
    const truncated = path.join(dir, 'truncated-model.bin');
    const handle = fs.openSync(modelPath, 'r');
    const head = Buffer.alloc(1024 * 1024);

    fs.readSync(handle, head, 0, head.length, 0);
    fs.closeSync(handle);
    fs.writeFileSync(truncated, head);

    const host = whisper.start({ debug: false });

    try {
      await host.ready();
      await assert.rejects(host.loadModel(truncated), /error: failed to initialize whisper context/);
    } finally {
      host.stop();
    }
  });

  it('reports a model file that does not exist as a failure', async () => {
    const host = whisper.start({ debug: false });

    try {
      await host.ready();
      await assert.rejects(host.loadModel(path.join(dir, 'no-such-model.bin')), /error: failed to initialize whisper context/);
    } finally {
      host.stop();
    }
  });
});
