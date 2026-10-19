'use strict';

// Runs bin/voxagent.js from start to finish against stand-ins for decibri, Ollama,
// the whisper model and the transcription child, and checks --file end to end: a
// file with speech is answered, a file with no speech or one that cannot be read
// stops before any model is loaded, and --file needs no terminal. Also checks the
// interactive loop: a recording reaches whisper only when speech was detected, Ctrl+C
// quits at every stage, a key pressed while voxagent answers is discarded, and with
// --memory the conversation goes with each question and H and C show and clear it.
// A platform the whisper addon has no binary for stops both before any of the
// stand-ins is used.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BIN, REPO, lib, helper } = require('../helpers/repo');
const { runNode, describeRun } = require('../helpers/run');

const { SYSTEM_MESSAGE } = require(lib('conversation'));

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

  it('asks the question on its own, with no system message, and reads no context length', async () => {
    const { run, events, names } = await runInWorld(['--file', 'question.wav'], { file: { speech: true, bytes: 84000 } });

    assert.strictEqual(run.status, 0, describeRun(run));

    const chat = events.find((entry) => entry.event === 'ollama.chat');
    assert.deepStrictEqual(chat.messages, [{ role: 'user', content: QUESTION }]);
    assert.deepStrictEqual(chat.fields, ['messages', 'model']);
    assert.ok(!names.includes('ollama.ps'), names.join(', '));
  });

  it('exits 2 with --memory before the file is read or any model is loaded', async () => {
    const { run, names } = await runInWorld(['--file', 'question.wav', '--memory'], { file: { speech: true, bytes: 84000 } });

    assert.strictEqual(run.status, 2, describeRun(run));
    assert.deepStrictEqual(run.lines, ["Error: Options '--file' and '--memory' cannot be combined.", 'Run voxagent --help for usage.']);
    assert.deepStrictEqual(names.filter((name) => name !== 'exit'), []);
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

  it('discards a key pressed while voxagent answers, so the next prompt waits for a new press', async () => {
    const { run, names } = await runInWorld([], {
      microphone: { speech: true },
      ollama: { models: ['llama3.2:latest'], answer: ANSWER, keyDuring: 'enter' },
      keys: ['enter', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes(ANSWER), describeRun(run));
    assert.strictEqual(names.filter((name) => name === 'microphone.open').length, 1, names.join(', '));
  });
});

describe('Ctrl+C', { timeout: 120000 }, () => {
  // Each case ends through the interrupt handling: exit 0, the transcription child
  // stopped, and the terminal put in raw mode once at startup and taken out of it once.
  function endedByInterrupt({ run, events, names }) {
    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(names.includes('whisper.stop'), names.join(', '));
    assert.deepStrictEqual(events.filter((entry) => entry.event === 'terminal.raw').map((entry) => entry.on), [true, false]);
  }

  it('quits at the prompt', async () => {
    const world = await runInWorld([], { microphone: { speech: true }, keys: ['ctrl-c'] });

    endedByInterrupt(world);
    assert.ok(!world.names.includes('microphone.open'), world.names.join(', '));
  });

  it('quits during a recording and releases the microphone', async () => {
    const world = await runInWorld([], { microphone: { speech: false }, keys: ['enter', 'ctrl-c'] });

    endedByInterrupt(world);
    assert.ok(world.names.includes('microphone.stop'), world.names.join(', '));
    assert.ok(!world.names.includes('whisper.transcribe'), world.names.join(', '));
  });

  it('quits during transcription', async () => {
    const world = await runInWorld([], {
      microphone: { speech: true },
      whisper: { text: QUESTION, keyDuring: 'ctrl-c' },
      keys: ['enter', 'none'],
    });

    endedByInterrupt(world);
    assert.ok(world.names.includes('whisper.transcribe'), world.names.join(', '));
    assert.ok(!world.names.includes('ollama.chat'), world.names.join(', '));
  });

  it('quits while voxagent waits for the answer', async () => {
    const world = await runInWorld([], {
      microphone: { speech: true },
      ollama: { models: ['llama3.2:latest'], answer: ANSWER, keyDuring: 'ctrl-c' },
      keys: ['enter', 'none'],
    });

    endedByInterrupt(world);
    assert.ok(world.names.includes('ollama.chat'), world.names.join(', '));
    assert.ok(!world.run.lines.includes(ANSWER), describeRun(world.run));
  });
});

describe('the interactive loop with --memory', { timeout: 120000 }, () => {
  const Q1 = 'What is the capital of Australia?';
  const A1 = 'The capital of Australia is Canberra.';
  const Q2 = 'How many people live there?';
  const A2 = 'About 470,000 people live in Canberra.';
  const Q3 = 'What is the tallest mountain?';
  const A3 = 'Mount Everest is the tallest mountain.';

  const SYSTEM = { role: 'system', content: SYSTEM_MESSAGE };
  const user = (content) => ({ role: 'user', content });
  const assistant = (content) => ({ role: 'assistant', content });

  const chats = (events) => events.filter((entry) => entry.event === 'ollama.chat');
  const count = (names, name) => names.filter((entry) => entry === name).length;

  // Three questions, each recorded at an ENTER press and answered in turn.
  const threeQuestions = {
    microphone: { speech: true },
    whisper: { texts: [Q1, Q2, Q3] },
    keys: ['enter', 'none', 'enter', 'none', 'enter', 'none', 'ctrl-c'],
  };

  it('names H and C at the prompt, and sends the first exchange with the second question after the system message', async () => {
    const { run, events } = await runInWorld(['--memory'], {
      ...threeQuestions,
      ollama: { models: ['llama3.2:latest'], answers: [A1, A2, A3] },
      keys: ['enter', 'none', 'enter', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes('Press ENTER to speak, H for history, C to clear, or Ctrl+C to quit.'), describeRun(run));
    assert.ok(!run.lines.includes('Press ENTER to speak, or Ctrl+C to quit.'), describeRun(run));

    const [first, second] = chats(events);

    assert.deepStrictEqual(first.messages, [SYSTEM, user(Q1)]);
    assert.deepStrictEqual(second.messages, [SYSTEM, user(Q1), assistant(A1), user(Q2)]);
    assert.deepStrictEqual(second.fields, ['messages', 'model']);
  });

  it('reads the context length once, after the warm-up and before the whisper model is checked', async () => {
    const { run, names } = await runInWorld(['--memory'], { microphone: { speech: true }, keys: ['ctrl-c'] });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.strictEqual(count(names, 'ollama.ps'), 1, names.join(', '));
    assert.ok(names.indexOf('ollama.generate') < names.indexOf('ollama.ps'), names.join(', '));
    assert.ok(names.indexOf('ollama.ps') < names.indexOf('model.ensure'), names.join(', '));
  });

  it('shows the conversation for H and starts no recording', async () => {
    const { run, names } = await runInWorld(['--memory'], { microphone: { speech: true }, keys: ['enter', 'none', 'h', 'ctrl-c'] });

    assert.strictEqual(run.status, 0, describeRun(run));

    const at = run.lines.indexOf('The conversation holds 1 of up to 10 exchanges.');

    assert.ok(at >= 0, describeRun(run));
    assert.deepStrictEqual(run.lines.slice(at, at + 4), [
      'The conversation holds 1 of up to 10 exchanges.',
      `1. You: ${QUESTION}`,
      `   ${ANSWER}`,
      'Press ENTER to speak, H for history, C to clear, or Ctrl+C to quit.',
    ]);
    assert.strictEqual(count(names, 'microphone.open'), 1, names.join(', '));
  });

  it('clears the conversation for C, so the next request carries the system message and one question', async () => {
    const { run, events, names } = await runInWorld(['--memory'], {
      ...threeQuestions,
      ollama: { models: ['llama3.2:latest'], answers: [A1, A2] },
      keys: ['enter', 'none', 'c', 'h', 'enter', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes('Conversation cleared.'), describeRun(run));
    assert.ok(run.lines.includes('The conversation is empty.'), describeRun(run));
    assert.deepStrictEqual(chats(events)[1].messages, [SYSTEM, user(Q2)]);
    assert.strictEqual(count(names, 'microphone.open'), 2, names.join(', '));
  });

  it('leaves the conversation as it was when an answer fails or is empty', async () => {
    const { run, events } = await runInWorld(['--memory'], {
      microphone: { speech: true },
      whisper: { texts: [Q1, Q2, Q3, 'And the longest river?'] },
      ollama: { models: ['llama3.2:latest'], answers: [A1, { error: 'model runner has unexpectedly stopped' }, '', A3] },
      keys: ['enter', 'none', 'enter', 'none', 'enter', 'none', 'enter', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes('Error: model runner has unexpectedly stopped'), describeRun(run));

    const sent = chats(events);

    assert.deepStrictEqual(sent[2].messages, [SYSTEM, user(Q1), assistant(A1), user(Q3)]);
    assert.deepStrictEqual(sent[3].messages, [SYSTEM, user(Q1), assistant(A1), user('And the longest river?')]);
  });

  it('keeps the number of exchanges --context sets, and reports the counts with --debug after each answer', async () => {
    const counts = (prompt, cached, answer) => ({
      prompt_eval_count: prompt,
      prompt_eval_cached_count: cached,
      eval_count: answer,
      load_duration: 22000000,
      prompt_eval_duration: 14000000,
    });

    const { run, events } = await runInWorld(['--memory', '--context', '1', '--debug'], {
      ...threeQuestions,
      ollama: {
        models: ['llama3.2:latest'],
        ps: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', context_length: 16384 }],
        answers: [{ text: A1, counts: counts(32, 23, 8) }, { text: A2, counts: counts(55, 39, 12) }, { text: A3, counts: counts(50, 0, 9) }],
      },
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.deepStrictEqual(chats(events)[2].messages, [SYSTEM, user(Q2), assistant(A2), user(Q3)]);
    assert.deepStrictEqual(run.lines.filter((line) => line.startsWith('[debug] prompt_eval_count')), [
      '[debug] prompt_eval_count=32 prompt_eval_cached_count=23 eval_count=8 load_duration=22ms prompt_eval_duration=14ms context_length=16384 exchanges_held=1 removed_before_question=0',
      '[debug] prompt_eval_count=55 prompt_eval_cached_count=39 eval_count=12 load_duration=22ms prompt_eval_duration=14ms context_length=16384 exchanges_held=1 removed_before_question=0',
      '[debug] prompt_eval_count=50 prompt_eval_cached_count=0 eval_count=9 load_duration=22ms prompt_eval_duration=14ms context_length=16384 exchanges_held=1 removed_before_question=1',
    ]);
  });

  it('uses a context length of 4096 for a model /api/ps does not list, and marks counts Ollama leaves out', async () => {
    const { run } = await runInWorld(['--memory', '--debug'], {
      microphone: { speech: true },
      ollama: { models: ['llama3.2:latest'], ps: [], answer: ANSWER },
      keys: ['enter', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes(
      '[debug] prompt_eval_count=absent prompt_eval_cached_count=absent eval_count=absent load_duration=absent prompt_eval_duration=absent context_length=4096 exchanges_held=1 removed_before_question=0',
    ), describeRun(run));
  });

  it('discards a key pressed while voxagent answers, so C then neither clears the conversation nor starts a recording', async () => {
    const { run, names } = await runInWorld(['--memory'], {
      microphone: { speech: true },
      ollama: { models: ['llama3.2:latest'], answer: ANSWER, keyDuring: 'c' },
      keys: ['enter', 'none', 'h', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(!run.lines.includes('Conversation cleared.'), describeRun(run));
    assert.ok(run.lines.includes('The conversation holds 1 of up to 10 exchanges.'), describeRun(run));
    assert.strictEqual(count(names, 'microphone.open'), 1, names.join(', '));
  });
});

describe('the interactive loop without --memory', { timeout: 120000 }, () => {
  it('prints the prompt line of 0.2.0, sends each question on its own, and starts a recording for H and C', async () => {
    const { run, events, names } = await runInWorld([], {
      microphone: { speech: true },
      whisper: { texts: ['First question?', 'Second question?'] },
      keys: ['h', 'none', 'c', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.strictEqual(run.lines.filter((line) => line === 'Press ENTER to speak, or Ctrl+C to quit.').length, 3, describeRun(run));
    assert.ok(!run.output.includes('H for history'), describeRun(run));
    assert.strictEqual(names.filter((name) => name === 'microphone.open').length, 2, names.join(', '));
    assert.ok(!names.includes('ollama.ps'), names.join(', '));

    const sent = events.filter((entry) => entry.event === 'ollama.chat');

    assert.deepStrictEqual(sent.map((entry) => entry.messages), [
      [{ role: 'user', content: 'First question?' }],
      [{ role: 'user', content: 'Second question?' }],
    ]);
    assert.deepStrictEqual(sent.map((entry) => entry.fields), [['messages', 'model'], ['messages', 'model']]);
  });
});

describe('an unsupported platform', { timeout: 120000 }, () => {
  const refusal = (platform, arch) => [
    `Error: voxagent does not support ${platform} on ${arch}.`,
    'Supported platforms: darwin-arm64, linux-x64, win32-x64.',
  ];

  // Every stand-in logs each call it receives, so an empty log apart from the exit shows
  // that Ollama was never asked, the whisper model was never checked or downloaded, no
  // audio file was opened, whisper was never started and the terminal was never used.
  const used = (names) => names.filter((name) => name !== 'exit');

  it('stops the interactive loop with exit 1 before Ollama, the whisper model or the terminal is used', async () => {
    const { run, names } = await runInWorld([], {
      platform: { platform: 'darwin', arch: 'x64' },
      microphone: { speech: true },
      keys: ['enter', 'none', 'ctrl-c'],
    });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, refusal('darwin', 'x64'));
    assert.deepStrictEqual(used(names), []);
  });

  it('stops --file with exit 1 before the file is read or Ollama or the whisper model is used', async () => {
    const { run, names } = await runInWorld(['--file', 'question.wav'], {
      platform: { platform: 'linux', arch: 'arm64' },
      file: { speech: true, bytes: 84000 },
    });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, refusal('linux', 'arm64'));
    assert.deepStrictEqual(used(names), []);
  });

  it('still prints the version and lists the input devices', async () => {
    const platform = { platform: 'darwin', arch: 'x64' };
    const devices = [{ id: 'input-1', name: 'Input One', maxInputChannels: 1, defaultSampleRate: 48000, isDefault: true }];

    const version = await runInWorld(['--version'], { platform });
    assert.strictEqual(version.run.status, 0, describeRun(version.run));
    assert.deepStrictEqual(version.run.lines, [JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version]);

    const listing = await runInWorld(['--list-devices'], { platform, devices });
    assert.strictEqual(listing.run.status, 0, describeRun(listing.run));
    assert.deepStrictEqual(listing.run.lines, [
      '* Input One (1 channels, 48000 Hz)',
      '    input-1',
      'The device marked * is the system default. Pass a name or an id to --device.',
    ]);
  });
});
