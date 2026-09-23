'use strict';

// Checks lib/capture.js against stand-ins for decibri: each of the five ways a
// recording ends, the audio delivered after the stop, the key wait left behind, the
// options the microphone and a file are opened with, the device error messages,
// device selection, and reading a file for --file.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { lib } = require('../helpers/repo');
const { stubModule, forget } = require('../helpers/modules');
const { fakeEngine, installFakeStdin } = require('../helpers/fakes');

let capture;
let ui;

before(() => {
  const unused = { open: async () => { throw new Error('the default engine is not used in these tests'); } };
  stubModule('decibri', { Microphone: unused, File: unused, inputDevices: () => [] });
  forget(lib('capture'));
  capture = require(lib('capture'));
  ui = require(lib('ui'));
});

after(() => {
  forget('decibri');
  forget(lib('capture'));
});

const chunk = (bytes, fill) => Buffer.alloc(bytes, fill);
const endOnStop = (stream) => setImmediate(() => stream.emit('end'));

// A key wait a test resolves by hand, in the shape ui.waitForKey returns.
function manualKey() {
  let press;
  const key = {
    cancelled: false,
    promise: new Promise((resolve) => {
      press = resolve;
    }),
    cancel() {
      key.cancelled = true;
    },
  };
  key.press = () => press('key');
  return key;
}

describe('the five ways a recording ends', { timeout: 20000 }, () => {
  it('ends on silence after speech, reporting speech', async () => {
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('speech');
        setTimeout(() => mic.emit('silence'), 20);
      },
      onStop: endOnStop,
    });

    const result = await capture.record({ engine, noSpeechMs: 5000 });

    assert.strictEqual(result.ending, capture.ENDING.SPEECH_ENDED);
    assert.strictEqual(result.speechDetected, true);
  });

  it('ends when ENTER is pressed, and cancels the key wait', async () => {
    const stopKey = manualKey();
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('speech');
        setTimeout(() => stopKey.press(), 20);
      },
      onStop: endOnStop,
    });

    const result = await capture.record({ engine, noSpeechMs: 5000, maxRecordingMs: 5000, stopKey });

    assert.strictEqual(result.ending, capture.ENDING.STOPPED);
    assert.strictEqual(stopKey.cancelled, true);
  });

  it('ends when no speech is detected in time, reporting no speech and returning the audio', async () => {
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
      },
      onStop: endOnStop,
    });

    const result = await capture.record({ engine, noSpeechMs: 50 });

    assert.strictEqual(result.ending, capture.ENDING.NO_SPEECH);
    assert.strictEqual(result.speechDetected, false);
    assert.strictEqual(result.audio.length, 3200);
  });

  it('ends at the maximum length when speech never stops', async () => {
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('speech');
      },
      onStop: endOnStop,
    });

    const result = await capture.record({ engine, noSpeechMs: 5000, maxRecordingMs: 50 });

    assert.strictEqual(result.ending, capture.ENDING.TOO_LONG);
    assert.strictEqual(result.speechDetected, true);
  });

  it('ends on a device error, carrying the error', async () => {
    const failure = Object.assign(new Error('decibri: audio device error: device disconnected'), { code: 'DEVICE_FAILED' });
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('speech');
        setTimeout(() => {
          // A capture failure destroys the stream, so no end follows it.
          mic.destroyed = true;
          mic.emit('error', failure);
        }, 20);
      },
    });

    const result = await capture.record({ engine, noSpeechMs: 5000, endWaitMs: 2000 });

    assert.strictEqual(result.ending, capture.ENDING.DEVICE_ERROR);
    assert.strictEqual(result.error, failure);
  });

  it('does not end on a silence event with no speech before it', async () => {
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('silence');
      },
      onStop: endOnStop,
    });

    const result = await capture.record({ engine, noSpeechMs: 100 });

    assert.strictEqual(result.ending, capture.ENDING.NO_SPEECH);
    assert.strictEqual(result.speechDetected, false);
  });
});

describe('the audio a recording returns', { timeout: 20000 }, () => {
  it('equals every byte the stream emitted, including the tail delivered after the stop', async () => {
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('speech');
        setTimeout(() => mic.emit('silence'), 20);
      },
      // The engine flushes what it had buffered after the stop and only then ends.
      onStop: (mic) => setImmediate(() => {
        mic.emit('data', chunk(424, 2));
        setImmediate(() => mic.emit('end'));
      }),
    });

    const result = await capture.record({ engine, noSpeechMs: 5000 });

    assert.strictEqual(result.audio.length, 3624);
    assert.strictEqual(result.audio[3623], 2);
  });

  it('is returned after the wait for the end runs out, when no end arrives', async () => {
    const engine = fakeEngine({
      onOpen: (mic) => {
        mic.emit('data', chunk(3200, 1));
        mic.emit('speech');
        setTimeout(() => mic.emit('silence'), 20);
      },
    });

    const started = Date.now();
    const result = await capture.record({ engine, noSpeechMs: 5000, endWaitMs: 200 });
    const elapsed = Date.now() - started;

    assert.strictEqual(result.audio.length, 3200);
    assert.ok(elapsed >= 190, `returned after ${elapsed} ms`);
  });
});

describe('the key wait after a recording ends by itself', { timeout: 20000 }, () => {
  it('leaves no stdin listener and takes the terminal out of raw mode', async () => {
    const terminal = installFakeStdin();

    try {
      const before = terminal.stdin.listenerCount('data');
      const engine = fakeEngine({
        onOpen: (mic) => {
          mic.emit('data', chunk(3200, 1));
          mic.emit('speech');
          setTimeout(() => mic.emit('silence'), 20);
        },
        onStop: endOnStop,
      });

      const stopKey = ui.waitForKey();
      const during = terminal.stdin.listenerCount('data');

      await capture.record({ engine, noSpeechMs: 5000, stopKey });

      assert.strictEqual(during, before + 1);
      assert.strictEqual(terminal.stdin.listenerCount('data'), before);
      assert.deepStrictEqual(terminal.stdin.rawModes, [true, false]);
    } finally {
      terminal.restore();
    }
  });
});

describe('the options the microphone is opened with', { timeout: 20000 }, () => {
  async function openedWith(settings) {
    const engine = fakeEngine({ onOpen: (mic) => mic.emit('data', chunk(3200, 1)), onStop: endOnStop });
    await capture.record({ engine, noSpeechMs: 10, ...settings });
    return engine.opened[0][0];
  }

  it('asks for 16 kHz mono int16 with the Silero detector and the end-of-speech pause, and no conditioning', async () => {
    const options = await openedWith({});

    assert.deepStrictEqual(options, {
      sampleRate: 16000,
      channels: 1,
      dtype: 'int16',
      vad: { model: 'silero', holdoffMs: capture.END_OF_SPEECH_MS },
    });
  });

  it('adds exactly one option, denoise, when --denoise is given', async () => {
    const plain = await openedWith({});
    const denoised = await openedWith({ denoise: true });

    assert.deepStrictEqual(denoised, { ...plain, denoise: 'fastenhancer-t' });
  });

  it('selects a device by its stable id when one is given', async () => {
    const options = await openedWith({ device: { id: 'wasapi:{b}', name: 'Line In' } });

    assert.deepStrictEqual(options.device, { id: 'wasapi:{b}' });
  });
});

describe('device errors', { timeout: 20000 }, () => {
  const messages = [
    ['MICROPHONE_NOT_FOUND', 'No microphone was found. Connect one, then run voxagent --list-devices to check it is seen.'],
    ['NO_MICROPHONE_FOUND', 'No microphone was found. Connect one, then run voxagent --list-devices to check it is seen.'],
    ['PERMISSION_DENIED', 'Microphone access is blocked. Allow microphone access for your terminal in the system privacy settings.'],
    ['DEVICE_FAILED', 'The microphone stopped responding. Check it is still connected, then press ENTER to try again.'],
    ['NOT_AN_INPUT_DEVICE', 'The selected device is not an input. Run voxagent --list-devices to see the inputs.'],
    ['MULTIPLE_DEVICES_MATCH', 'More than one input matched. Pass an id to --device, which you can read from voxagent --list-devices.'],
    ['DEVICE_ENUMERATION_FAILED', 'The audio devices could not be listed. Check the system sound settings.'],
  ];

  for (const [code, message] of messages) {
    it(`translates ${code} into a message that says what to do`, () => {
      const err = Object.assign(new Error('decibri message'), { code });
      assert.strictEqual(capture.deviceErrorMessage(err), message);
    });
  }

  it('passes any other error through with its own message', () => {
    const err = Object.assign(new Error('something else'), { code: 'RESAMPLE_FAILED' });
    assert.strictEqual(capture.deviceErrorMessage(err), 'something else');
  });

  it('rejects when the microphone cannot be opened', async () => {
    const failure = Object.assign(new Error('No microphone found matching "x"'), { code: 'MICROPHONE_NOT_FOUND' });
    const engine = fakeEngine({ failWith: failure });

    await assert.rejects(capture.record({ engine }), (err) => err === failure);
  });
});

describe('device selection', () => {
  const devices = [
    { name: 'Microphone', id: 'wasapi:{a}', isDefault: true },
    { name: 'Line In', id: 'wasapi:{b}', isDefault: false },
    { name: 'Microphone', id: 'wasapi:{c}', isDefault: false },
  ];
  const ids = (list) => list.map((device) => device.id);

  it('selects exactly one device by its stable id', () => {
    assert.deepStrictEqual(ids(capture.resolveDevice('wasapi:{c}', devices)), ['wasapi:{c}']);
  });

  it('returns every device a name matches, ignoring case, so an ambiguous name can be reported', () => {
    assert.deepStrictEqual(ids(capture.resolveDevice('Microphone', devices)), ['wasapi:{a}', 'wasapi:{c}']);
    assert.deepStrictEqual(ids(capture.resolveDevice('microphone', devices)), ['wasapi:{a}', 'wasapi:{c}']);
  });

  it('selects the one device a unique name matches, and none for a name that matches nothing', () => {
    assert.deepStrictEqual(ids(capture.resolveDevice('Line', devices)), ['wasapi:{b}']);
    assert.deepStrictEqual(capture.resolveDevice('Nothing Here', devices), []);
  });
});

describe('reading a file for --file', { timeout: 20000 }, () => {
  function fileEngine(behaviour) {
    const settings = { speech: true, chunks: 3, ...behaviour };

    return fakeEngine({
      failWith: settings.failWith,
      onOpen: (source) => {
        for (let i = 0; i < settings.chunks; i++) {
          if (i === 0 && settings.speech) {
            source.emit('speech');
          }
          source.emit('data', chunk(3200, i + 1));
        }

        if (settings.streamError) {
          source.emit('error', settings.streamError);
          return;
        }

        source.emit('end');
      },
    });
  }

  it('opens the file with the options the microphone uses, apart from the device', async () => {
    const engine = fileEngine({});
    await capture.readFile('question.wav', { engine });

    const [filePath, options] = engine.opened[0];

    assert.strictEqual(filePath, 'question.wav');
    assert.deepStrictEqual(options, {
      sampleRate: 16000,
      channels: 1,
      dtype: 'int16',
      vad: { model: 'silero', holdoffMs: capture.END_OF_SPEECH_MS },
    });
  });

  it('adds exactly one option, denoise, when --denoise is given', async () => {
    const plain = fileEngine({});
    const denoised = fileEngine({});
    await capture.readFile('question.wav', { engine: plain });
    await capture.readFile('question.wav', { engine: denoised, denoise: true });

    assert.deepStrictEqual(denoised.opened[0][1], { ...plain.opened[0][1], denoise: 'fastenhancer-t' });
  });

  it('returns every byte the file delivered and reports the speech the detector found', async () => {
    const engine = fileEngine({ chunks: 4 });
    const result = await capture.readFile('question.wav', { engine });

    assert.strictEqual(result.audio.length, 12800);
    assert.strictEqual(result.audio[12799], 4);
    assert.strictEqual(result.speechDetected, true);
    assert.strictEqual(engine.streams[0].closeCalls, 1);
  });

  it('reports no speech for a file the detector found none in', async () => {
    const result = await capture.readFile('silence.wav', { engine: fileEngine({ speech: false }) });

    assert.strictEqual(result.speechDetected, false);
    assert.strictEqual(result.audio.length, 9600);
  });

  it('rejects with the error decibri raises when the file cannot be opened', async () => {
    const failure = Object.assign(new Error('Failed to read audio file missing.wav: not found'), { code: 'FILE_READ_FAILED' });

    await assert.rejects(capture.readFile('missing.wav', { engine: fileEngine({ failWith: failure }) }), (err) => err === failure);
  });

  it('rejects with the stream error when decoding fails part way, and still closes the file', async () => {
    const failure = Object.assign(new Error('truncated audio file: input ended early'), { code: 'AUDIO_FILE_TRUNCATED' });
    const engine = fileEngine({ streamError: failure });

    await assert.rejects(capture.readFile('cut.wav', { engine }), (err) => err === failure);
    assert.strictEqual(engine.streams[0].closeCalls, 1);
  });
});

describe('the message for a file that cannot be used', () => {
  it('names the file and gives the reason decibri reports for a failed read, once', () => {
    const err = new Error('Failed to read audio file missing.wav: The system cannot find the file specified. (os error 2)');

    assert.strictEqual(
      capture.fileErrorMessage('missing.wav', err),
      "Cannot read 'missing.wav': The system cannot find the file specified. (os error 2)"
    );
  });

  it('names the file and keeps the whole of a decoding failure, which does not name it', () => {
    const err = new Error("unsupported audio format: unrecognised container, leading bytes were 'This'");

    assert.strictEqual(
      capture.fileErrorMessage('notes.wav', err),
      "Cannot read 'notes.wav': unsupported audio format: unrecognised container, leading bytes were 'This'"
    );
  });
});
