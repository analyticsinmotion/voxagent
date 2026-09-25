'use strict';

// Runs --file with the real decibri, whisper addon and whisper model, and a
// stand-in Ollama, and reads the fixture through decibri's File source directly.
// Runs when VOXAGENT_INTEGRATION includes transcription; the model is downloaded if
// absent.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BIN, REPO, FIXTURE, FIXTURE_TEXT, lib, helper } = require('../helpers/repo');
const { skipUnless } = require('../helpers/integration');
const { runNode, describeRun } = require('../helpers/run');
const { readWavPayload, wavFile } = require('../helpers/wav');

const ANSWER = 'The capital of Australia is Canberra.';

function rms(buffer, read) {
  let sum = 0;
  const count = Math.floor(buffer.length / 2);

  for (let i = 0; i < count; i++) {
    const sample = read(buffer, i * 2);
    sum += sample * sample;
  }

  return Math.sqrt(sum / count);
}

describe('--file with the real decibri and whisper', { skip: skipUnless('transcription'), timeout: 20 * 60 * 1000 }, () => {
  let dir;

  before(async () => {
    await require(lib('model')).ensureModel();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-file-integration-'));
  });

  after(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the fixture as 16 kHz mono int16, byte for byte, and detects its speech', async () => {
    const { audio, speechDetected } = await require(lib('capture')).readFile(FIXTURE, {});

    assert.ok(audio.equals(readWavPayload(FIXTURE)));
    assert.strictEqual(speechDetected, true);
  });

  // Read with the wrong byte order, speech turns into loud noise. The fixture reads
  // 14.4 dB quieter little-endian than swapped, so audio delivered with its bytes
  // swapped would read 14.4 dB louder, and 10 dB separates the two.
  it('delivers little-endian samples, which read at least 10 dB quieter than the same bytes swapped', async () => {
    const { audio } = await require(lib('capture')).readFile(FIXTURE, {});
    const littleEndian = rms(audio, (buffer, at) => buffer.readInt16LE(at));
    const swapped = rms(audio, (buffer, at) => buffer.readInt16BE(at));

    assert.ok(20 * Math.log10(swapped / littleEndian) >= 10, `${littleEndian} against ${swapped}`);
  });

  it('prints the transcript and the answer and exits 0 for the fixture, with Ollama stubbed', async () => {
    const run = await runNode([BIN, '--file', FIXTURE], {
      preload: [helper('ollama-stub')],
      env: { VOXAGENT_TEST_ANSWER: ANSWER },
      cwd: REPO,
      timeoutMs: 10 * 60 * 1000,
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes(`You: ${FIXTURE_TEXT}`), describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], ANSWER);
  });

  it('prints No speech detected. and exits 1 for one second of silence, before any model is checked', async () => {
    const silence = path.join(dir, 'silence.wav');
    fs.writeFileSync(silence, wavFile(Buffer.alloc(32000), 16000, 1));

    const run = await runNode([BIN, '--file', silence], {
      preload: [helper('ollama-stub')],
      env: { VOXAGENT_TEST_ANSWER: ANSWER },
      cwd: REPO,
      timeoutMs: 5 * 60 * 1000,
    });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], 'No speech detected.');
    assert.ok(!run.output.includes('Checking Ollama connection'), describeRun(run));
  });
});
