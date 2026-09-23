'use strict';

// Runs bin/voxagent.js from start to finish against stand-ins for decibri, Ollama,
// the whisper model and the transcription child, and checks --file end to end: a
// file with speech is answered, a file with no speech or one that cannot be read
// stops before any model is loaded, and --file needs no terminal. Also checks that
// the interactive loop sends a recording to whisper only when speech was detected.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BIN, REPO, helper } = require('../helpers/repo');
const { runNode, describeRun } = require('../helpers/run');

const QUESTION = 'What is the capital of Australia?';
const ANSWER = 'The capital of Australia is Canberra.';

let dir;
let runs = 0;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-file-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Runs voxagent in the fake world and returns the run with the events it logged.
async function runInWorld(args, world) {
  const log = path.join(dir, `world-${runs++}.log`);
  const run = await runNode([BIN, ...args], {
    preload: [helper('fake-world')],
    env: {
      VOXAGENT_TEST_WORLD: JSON.stringify({
        log,
        ollama: { models: ['llama3.2:latest'], answer: ANSWER },
        whisper: { text: QUESTION },
        ...world,
      }),
    },
    cwd: REPO,
  });
  const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

  return { run, events, names: events.map((entry) => entry.event) };
}

const MICROPHONE_OPTIONS = {
  sampleRate: 16000,
  channels: 1,
  dtype: 'int16',
  vad: { model: 'silero', holdoffMs: 1500 },
};

describe('--file', { timeout: 120000 }, () => {
  it('prints the transcript and the answer and exits 0 for a file with speech, with input not a terminal', async () => {
    const { run, events, names } = await runInWorld(['--file', 'question.wav'], { file: { speech: true, bytes: 84000 } });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes(`You: ${QUESTION}`), describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], ANSWER);

    const open = events.find((entry) => entry.event === 'file.open');
    assert.strictEqual(open.filePath, 'question.wav');
    assert.deepStrictEqual(open.options, MICROPHONE_OPTIONS);

    const transcribe = events.find((entry) => entry.event === 'whisper.transcribe');
    assert.strictEqual(transcribe.bytes, 84000);

    const chat = events.find((entry) => entry.event === 'ollama.chat');
    assert.strictEqual(chat.content, QUESTION);
    assert.ok(!names.includes('terminal.raw'), 'the terminal was never put in raw mode');
  });

  it('reads the file first, then runs the same startup as the interactive loop from the Ollama check on', async () => {
    const { run, names } = await runInWorld(['--file', 'question.wav'], { file: { speech: true, bytes: 84000 } });

    assert.strictEqual(run.status, 0, describeRun(run));

    const order = ['file.open', 'ollama.list', 'ollama.generate', 'model.ensure', 'whisper.start', 'whisper.load', 'whisper.transcribe', 'ollama.chat'];
    const positions = order.map((name) => names.indexOf(name));

    assert.ok(positions.every((position) => position >= 0), names.join(', '));
    assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions, names.join(', '));
  });

  it('prints No speech detected. and exits 1 for a file with no speech, without starting whisper or asking Ollama', async () => {
    const { run, names } = await runInWorld(['--file', 'silence.wav'], { file: { speech: false, bytes: 32000 } });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], 'No speech detected.');
    assert.ok(!names.includes('whisper.start'), names.join(', '));
    assert.ok(!names.some((name) => name.startsWith('ollama.')), names.join(', '));
  });

  it('prints No speech detected. and exits 1 when whisper returns no text, without asking Ollama a question', async () => {
    const { run, names } = await runInWorld(['--file', 'question.wav'], { file: { speech: true, bytes: 84000 }, whisper: { text: '' } });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], 'No speech detected.');
    assert.ok(names.includes('whisper.transcribe'));
    assert.ok(!names.includes('ollama.chat'));
  });

  it('names the file and the reason and exits 1 for a file that cannot be read, before any model is loaded', async () => {
    const message = 'Failed to read audio file missing.wav: The system cannot find the file specified. (os error 2)';
    const { run, names } = await runInWorld(['--file', 'missing.wav'], { file: { error: { code: 'FILE_READ_FAILED', message } } });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], "Error: Cannot read 'missing.wav': The system cannot find the file specified. (os error 2)");
    assert.deepStrictEqual(names.filter((name) => name !== 'exit'), ['file.open']);
  });

  it('names the file and the reason and exits 1 for a file decibri cannot decode, before any model is loaded', async () => {
    const message = "unsupported audio format: unrecognised container, leading bytes were 'This'";
    const { run, names } = await runInWorld(['--file', 'notes.wav'], { file: { error: { code: 'AUDIO_FORMAT_UNSUPPORTED', message } } });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.strictEqual(run.lines[run.lines.length - 1], `Error: Cannot read 'notes.wav': ${message}`);
    assert.deepStrictEqual(names.filter((name) => name !== 'exit'), ['file.open']);
  });

  it('exits 1 naming a missing Ollama model before whisper is started', async () => {
    const { run, names } = await runInWorld(['--file', 'question.wav'], {
      file: { speech: true, bytes: 84000 },
      ollama: { models: ['qwen3:14b'], answer: ANSWER },
    });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.ok(run.lines.includes("Error: Ollama model 'llama3.2' is not installed."), describeRun(run));
    assert.ok(!names.includes('whisper.start'));
  });

  it('opens the file with denoise when --denoise is given', async () => {
    const { run, events } = await runInWorld(['--file', 'question.wav', '--denoise'], { file: { speech: true, bytes: 84000 } });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.deepStrictEqual(events.find((entry) => entry.event === 'file.open').options, { ...MICROPHONE_OPTIONS, denoise: 'fastenhancer-t' });
  });
});

describe('the interactive loop', { timeout: 120000 }, () => {
  it('never sends a recording with no speech detected to whisper', async () => {
    const { run, names } = await runInWorld([], { microphone: { speech: false }, keys: ['enter', 'enter', 'ctrl-c'] });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes('No speech detected.'), describeRun(run));
    assert.ok(names.includes('microphone.stop'), names.join(', '));
    assert.ok(!names.includes('whisper.transcribe'), names.join(', '));
    assert.ok(!names.includes('ollama.chat'), names.join(', '));
  });

  it('sends a recording with speech detected to whisper and prints the answer', async () => {
    const { run, events } = await runInWorld([], { microphone: { speech: true }, keys: ['enter', 'none', 'ctrl-c'] });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes(`You: ${QUESTION}`), describeRun(run));
    assert.ok(run.lines.includes(ANSWER), describeRun(run));
    assert.strictEqual(events.find((entry) => entry.event === 'whisper.transcribe').bytes, 12 * 3200);
    assert.deepStrictEqual(events.find((entry) => entry.event === 'microphone.open').options, MICROPHONE_OPTIONS);
  });
});
