'use strict';

// Checks lib/stt.js over a stand-in for the native whisper function: the int16 to
// float conversion, the options that reach the native function, the warm-up, the
// --debug recording, and the loader that runs the macOS binary, which must hand the
// native function exactly what the addon's own wrapper does.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lib } = require('../helpers/repo');
const { stubModule, forget, stubWhisperNative, loadAddonWrapper, whisperDist, WHISPER_PACKAGE } = require('../helpers/modules');
const { fakeWhisper } = require('../helpers/fakes');

const MODEL = path.join(os.tmpdir(), 'model-for-a-stand-in.bin');

let native;
let stt;

before(() => {
  native = fakeWhisper({ text: ' What is the capital of Australia?' });
  stubWhisperNative(native);
  stt = require(lib('stt'));
});

after(() => {
  forget(lib('stt'));
  forget(WHISPER_PACKAGE);
});

function int16(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
}

describe('the int16 to float conversion', { timeout: 120000 }, () => {
  it('maps -32768, -1, 0 and 32767 exactly, into a Float32Array', () => {
    const samples = stt.toFloat32Samples(int16([-32768, -1, 0, 32767]));

    assert.ok(samples instanceof Float32Array);
    assert.deepStrictEqual(Array.from(samples), [-1, -0.000030517578125, 0, 0.999969482421875]);
  });

  it('drops an odd trailing byte', () => {
    const samples = stt.toFloat32Samples(Buffer.concat([int16([100, -100]), Buffer.from([7])]));

    assert.strictEqual(samples.length, 2);
  });

  it('reads a buffer that starts at an odd byte offset', () => {
    const odd = Buffer.concat([Buffer.alloc(1), int16([-32768, 32767])]).subarray(1);

    assert.strictEqual(odd.byteOffset % 2, 1);
    assert.deepStrictEqual(Array.from(stt.toFloat32Samples(odd)), [-1, 0.999969482421875]);
  });
});

describe('what reaches the native whisper function', { timeout: 120000 }, () => {
  it('refuses empty audio before the native function is called', async () => {
    const before = native.calls.length;

    await assert.rejects(stt.transcribe(Buffer.alloc(0), MODEL, false), /There is no audio to transcribe\./);
    await assert.rejects(stt.transcribe(Buffer.alloc(1), MODEL, false), /There is no audio to transcribe\./);
    assert.strictEqual(native.calls.length, before);
  });

  it('returns the transcript text without its timestamps', async () => {
    assert.strictEqual(await stt.transcribe(int16([1, 2, 3, 4]), MODEL, false), 'What is the capital of Australia?');
  });

  it('never passes fname_inp, and passes the samples as a Float32Array', async () => {
    await stt.loadModel(MODEL);
    await stt.transcribe(int16([1, 2, 3, 4]), MODEL, false);

    for (const params of native.calls) {
      assert.ok(!('fname_inp' in params), 'fname_inp is absent');
      assert.ok(params.pcmf32 instanceof Float32Array);
    }
  });

  it('passes translate as false', async () => {
    await stt.transcribe(int16([1, 2, 3, 4]), MODEL, false);

    assert.strictEqual(native.calls[native.calls.length - 1].translate, false);
  });

  it('warms up with the same options as a real call, and one second of silence', async () => {
    await stt.loadModel(MODEL);
    const warmUp = native.calls[native.calls.length - 1];
    await stt.transcribe(int16([1, 2, 3, 4]), MODEL, false);
    const call = native.calls[native.calls.length - 1];

    const { pcmf32: silence, ...warmUpOptions } = warmUp;
    const { pcmf32: audio, ...callOptions } = call;

    assert.deepStrictEqual(warmUpOptions, callOptions);
    assert.strictEqual(warmUpOptions.model, MODEL);
    assert.ok(silence instanceof Float32Array);
    assert.strictEqual(silence.length, 16000);
    assert.ok(silence.every((sample) => sample === 0));
    assert.strictEqual(audio.length, 4);
  });

  it('sets every option the addon would otherwise supply from its defaults', () => {
    const wrapper = fakeWhisper({});
    const addon = loadAddonWrapper(wrapper);

    return addon.transcribe({ model: MODEL, pcmf32: new Float32Array(1) }).then(() => {
      const defaults = Object.keys(wrapper.calls[0]).filter((key) => key !== 'model' && key !== 'pcmf32');
      const options = stt.whisperOptions(new Float32Array(1), MODEL);

      assert.ok(defaults.length > 0);
      for (const key of defaults) {
        assert.ok(key in options, `${key} is passed explicitly`);
      }
    });
  });
});

describe('--debug', { timeout: 120000 }, () => {
  let dir;
  let cwd;

  before(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-debug-'));
    process.chdir(dir);
  });

  after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the recording to debug-capture.wav in the working directory and prints its full path', async () => {
    const pcm = int16([100, -100, 2000, -2000, 0]);
    const printed = [];
    const realLog = console.log;

    console.log = (...args) => printed.push(args.join(' '));

    try {
      await stt.transcribe(pcm, MODEL, true);
    } finally {
      console.log = realLog;
    }

    const file = path.join(process.cwd(), 'debug-capture.wav');
    const written = fs.readFileSync(file);

    assert.strictEqual(written.length, 44 + pcm.length);
    assert.ok(written.subarray(44).equals(pcm));
    assert.ok(printed.some((line) => line.includes(file) && line.includes(`(${written.length} bytes)`)), printed.join('\n'));
  });
});

describe('the loader for the macOS binary', { timeout: 120000 }, () => {
  const macBinary = path.join(whisperDist(), 'mac-arm64', 'whisper.node');

  // Runs one call through the macOS loader and one through the addon's own wrapper,
  // each over its own stand-in, and returns what each native function received.
  async function bothReceive(options) {
    const mac = fakeWhisper({});
    const wrapped = fakeWhisper({});

    stubModule(macBinary, { whisper: mac });
    try {
      await stt.loadWhisper('darwin', 'arm64')(options);
    } finally {
      forget(macBinary);
    }

    await loadAddonWrapper(wrapped).transcribe(options);

    return { mac: mac.calls[0], wrapper: wrapped.calls[0] };
  }

  const optionSets = [
    ['the options voxagent passes', () => stt.whisperOptions(new Float32Array(3), MODEL)],
    ['only a model and samples', () => ({ model: MODEL, pcmf32: new Float32Array(3) })],
    ['options that override the defaults', () => ({ model: MODEL, pcmf32: new Float32Array(3), translate: true, language: 'de', max_len: 5, extra: 'x' })],
  ];

  for (const [label, options] of optionSets) {
    it(`hands the native function what the addon's wrapper hands it, for ${label}, in the same order`, async () => {
      const { mac, wrapper } = await bothReceive(options());

      assert.deepStrictEqual(mac, wrapper);
      assert.deepStrictEqual(Object.keys(mac), Object.keys(wrapper));
    });
  }

  it("makes the wrapper's two checks, rejecting without calling the native function", async () => {
    const mac = fakeWhisper({});
    stubModule(macBinary, { whisper: mac });

    try {
      const transcribe = stt.loadWhisper('darwin', 'arm64');
      await assert.rejects(transcribe({ pcmf32: new Float32Array(1) }), /^Error: Model path is required$/);
      await assert.rejects(transcribe({ model: MODEL }), /^Error: Input file path is required$/);
      assert.strictEqual(mac.calls.length, 0);
    } finally {
      forget(macBinary);
    }

    const wrapped = fakeWhisper({});
    const addon = loadAddonWrapper(wrapped);
    await assert.rejects(addon.transcribe({ pcmf32: new Float32Array(1) }), /^Error: Model path is required$/);
    await assert.rejects(addon.transcribe({ model: MODEL }), /^Error: Input file path is required$/);
  });

  it('turns the native callback into a promise, resolving with its result and rejecting with its error', async () => {
    const result = { transcription: [] };
    const failure = new Error('native failure');

    for (const behaviour of [{ result }, { error: failure }]) {
      stubModule(macBinary, { whisper: fakeWhisper(behaviour) });

      try {
        const outcome = stt.loadWhisper('darwin', 'arm64')({ model: MODEL, pcmf32: new Float32Array(1) });

        if (behaviour.error) {
          await assert.rejects(outcome, (err) => err === failure);
        } else {
          assert.strictEqual(await outcome, result);
        }
      } finally {
        forget(macBinary);
      }
    }
  });

  it('reports a binary that cannot load in the words the addon uses', () => {
    const realDlopen = process.dlopen;

    forget(macBinary);
    process.dlopen = () => {
      throw new Error('this binary cannot be loaded here');
    };

    try {
      assert.throws(() => stt.loadWhisper('darwin', 'arm64'), /^Error: Failed to load native addon: Error: this binary cannot be loaded here$/);
    } finally {
      process.dlopen = realDlopen;
    }
  });

  it("requires the addon's own entry point on every other platform", () => {
    const own = async () => {};
    const entry = require.resolve(WHISPER_PACKAGE, { paths: [path.dirname(lib('stt'))] });
    const saved = require.cache[entry];

    stubModule(WHISPER_PACKAGE, { transcribe: own });

    try {
      assert.strictEqual(stt.loadWhisper('linux', 'x64'), own);
      assert.strictEqual(stt.loadWhisper('win32', 'x64'), own);
      assert.strictEqual(stt.loadWhisper('darwin', 'x64'), own);

      stubModule(macBinary, { whisper: fakeWhisper({}) });
      assert.notStrictEqual(stt.loadWhisper('darwin', 'arm64'), own);
    } finally {
      forget(macBinary);
      if (saved) {
        require.cache[entry] = saved;
      } else {
        delete require.cache[entry];
      }
    }
  });
});
