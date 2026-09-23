'use strict';

// Checks lib/whisper.js: the lines that mark a failed call, and the transcription
// child itself, forked for real and running lib/stt.js over a stand-in for the
// native whisper function. Covers what reaches the user's terminal, how a failure
// is reported, how often the child is started, and that the audio travels to the
// child through a pipe and never through a file.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lib, helper } = require('../helpers/repo');
const fsSpy = require('../helpers/fs-spy');

// Counts every child forked and every byte written to a child's standard input.
// lib/whisper.js takes fork from child_process as it loads, so this is in place
// before it is required.
const counts = { forks: 0, stdinBytes: 0 };
const realFork = childProcess.fork;

childProcess.fork = function countingFork(...args) {
  const child = realFork.apply(this, args);
  const realWrite = child.stdin.write.bind(child.stdin);

  counts.forks += 1;
  child.stdin.write = (chunk, ...rest) => {
    counts.stdinBytes += chunk.length;
    return realWrite(chunk, ...rest);
  };

  return child;
};

const whisper = require(lib('whisper'));

const MODEL = path.join(os.tmpdir(), 'model-for-a-stand-in.bin');
const TIMEOUT = { timeout: 30000 };

// What the child writes when it cannot load a model, from a truncated model file.
const LOAD_FAILURE = [
  "whisper_init_from_file_with_params_no_state: loading model from '/tmp/truncated-model.bin'",
  'whisper_model_load: loading model',
  'whisper_model_load: model size    =    0.92 MB',
  'whisper_model_load: ERROR not all tensors loaded from model file - expected 245, got 1',
  'whisper_init_with_params_no_state: failed to load model',
  'error: failed to initialize whisper context',
];

describe('the lines that mark a failed call', () => {
  // Every line whisper or the addon writes when a load or a call fails.
  const failures = [
    'whisper_model_load: ERROR not all tensors loaded from model file - expected 245, got 1',
    'whisper_init_with_params_no_state: failed to load model',
    'error: failed to initialize whisper context',
    'failed to process audio',
    'error: no input files or audio buffer specified',
    "error: unknown language 'xx'",
    "error: failed to read audio file 'buffer'",
    'Error: failed to open audio data from stdin (read_audio_data)',
    "whisper_init_from_file_with_params_no_state: failed to open '/tmp/no-such-model.bin'",
    'whisper_model_load: invalid model data (bad magic)',
    'whisper_model_load: invalid model (bad ftype value 9)',
    "whisper_model_load: unknown tensor 'encoder.x' in model file",
    "whisper_model_load: tensor 'encoder.conv1.weight' has wrong size in model file",
    'whisper_model_load: shape: [3, 80, 512], expected: [3, 80, 384]',
    "whisper_model_load: tensor 'encoder.conv1.weight' has wrong shape in model file: got [3, 80, 512], expected [3, 80, 384]",
    'whisper_init_state: whisper_backend_init() failed',
    'whisper_init_state: whisper_kv_cache_init() failed for self-attention cache',
    'whisper_init_state: failed to init encoder allocator',
    'whisper_kv_cache_init: failed to allocate memory for the kv cache',
    'whisper_sched_graph_init: failed to allocate the compute buffer',
    'whisper_full_with_state: failed to encode',
    'error: Internal Error (0000000e:Internal Error)',
  ];

  // Every line written while a model loads and a call runs, on Windows with
  // Vulkan, on Linux and on macOS, including lines that report a problem whisper
  // recovers from and lines that only mention the word error.
  const ordinary = [
    "whisper_init_from_file_with_params_no_state: loading model from '/models/ggml-base.en.bin'",
    'whisper_init_with_params_no_state: use gpu    = 1',
    'whisper_init_with_params_no_state: flash attn = 0',
    'whisper_init_with_params_no_state: gpu_device = 0',
    'whisper_init_with_params_no_state: dtw        = 0',
    'ggml_vulkan: Found 1 Vulkan devices:',
    'ggml_vulkan: 0 = Example GPU (Example) | uma: 0 | fp16: 1 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: none',
    'whisper_init_with_params_no_state: devices    = 3',
    'whisper_init_with_params_no_state: backends   = 3',
    'whisper_model_load: loading model',
    'whisper_model_load: n_vocab       = 51864',
    'whisper_model_load: n_audio_ctx   = 1500',
    'whisper_model_load: type          = 2 (base)',
    'whisper_model_load: adding 1607 extra tokens',
    'whisper_model_load: n_langs       = 99',
    'whisper_model_load:      Vulkan0 total size =   147.37 MB',
    'whisper_model_load: model size    =  147.37 MB',
    'whisper_backend_init_gpu: using Vulkan0 backend',
    'whisper_backend_init: using BLAS backend',
    'whisper_init_state: kv self size  =    6.29 MB',
    'whisper_init_state: compute buffer (decode) =   97.29 MB',
    'info: using audio buffer as input',
    'whisper_backend_init_gpu: no GPU found',
    'whisper_backend_init_gpu: using Metal backend',
    'whisper_backend_init_gpu: failed to initialize Metal backend',
    'whisper_backend_init_gpu: failed to initialize Vulkan0 backend',
    'whisper_backend_init: failed to initialize BLAS backend',
    'ggml_metal_init: picking default device: Apple M1',
    'ggml_metal_init: error: metal library is nil',
    'ggml_metal_load_library: error: could not use bundle path to find ggml-metal.metal, falling back to trying cwd',
    'ggml_metal_init: skipping kernel_mul_mm_bf16_f32                   (not supported)',
    'ggml_vulkan: Failed to allocate pinned memory (out of device memory)',
    'WARNING: failed to allocate 12.00 MB of pinned memory',
    'run_with_progress: WARNING: model is not multilingual, ignoring language and translation options',
    'a line that mentions an error in passing',
    'error_count: 0',
  ];

  it('matches every line written when a load or a call fails', () => {
    for (const line of failures) {
      assert.deepStrictEqual(whisper.failureLines(line), [line], line);
    }
  });

  it('matches no line written in ordinary use, nor one that only mentions an error', () => {
    assert.deepStrictEqual(whisper.failureLines(ordinary.join('\n')), []);
  });

  it('picks out exactly the failure lines from the output of a load that failed', () => {
    assert.deepStrictEqual(whisper.failureLines(LOAD_FAILURE.join('\r\n')), [
      'whisper_model_load: ERROR not all tensors loaded from model file - expected 245, got 1',
      'whisper_init_with_params_no_state: failed to load model',
      'error: failed to initialize whisper context',
    ]);
  });
});

describe('the transcription child', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-whisper-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Starts the real child with the stand-in whisper function behaving as given.
  // fork passes this process's environment to the child, so the preloads and the
  // behaviour are set in it for the moment of the fork and then put back. Extra
  // preloads run in the child after the stand-in is in place.
  function startChild(behaviour, options) {
    const settings = { debug: false, preload: [], env: {}, ...options };
    const preloads = [helper('whisper-child-preload'), ...settings.preload];
    const values = {
      NODE_OPTIONS: preloads.map((file) => `--require "${file.replace(/\\/g, '/')}"`).join(' '),
      VOXAGENT_TEST_WHISPER: JSON.stringify(behaviour),
      NODE_TEST_CONTEXT: undefined,
      ...settings.env,
    };
    const saved = {};

    for (const [name, value] of Object.entries(values)) {
      saved[name] = process.env[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    try {
      return whisper.start({ debug: settings.debug });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  }

  // Replaces the process's own standard stream writes for the length of fn, and
  // collects any write that carries the given text or a call marker. Every other
  // write goes through.
  async function watchStreams(text, fn) {
    const seen = [];
    const real = { out: process.stdout.write, err: process.stderr.write };

    const watch = (stream, name) => function write(chunk, ...rest) {
      const written = String(chunk);

      if (written.includes(text) || written.includes('voxagent-call-end')) {
        seen.push({ stream: name, text: written });
        return true;
      }
      return real[name].call(stream, chunk, ...rest);
    };

    process.stdout.write = watch(process.stdout, 'out');
    process.stderr.write = watch(process.stderr, 'err');

    try {
      await fn();
    } finally {
      process.stdout.write = real.out;
      process.stderr.write = real.err;
    }

    return seen;
  }

  const readCalls = (log) => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.keys);

  it('loads the model and transcribes twice in one child, returning the transcript', TIMEOUT, async () => {
    const log = path.join(dir, 'calls-twice.log');
    const forksBefore = counts.forks;
    const host = startChild({ text: ' What is the capital of Australia?', log });

    try {
      await host.ready();
      await host.loadModel(MODEL);
      assert.strictEqual(await host.transcribe(Buffer.alloc(3200, 1), MODEL, false), 'What is the capital of Australia?');
      assert.strictEqual(await host.transcribe(Buffer.alloc(3200, 1), MODEL, false), 'What is the capital of Australia?');
    } finally {
      host.stop();
    }

    const calls = readCalls(log);

    assert.strictEqual(counts.forks - forksBefore, 1);
    assert.strictEqual(new Set(calls.map((call) => call.pid)).size, 1);
    assert.deepStrictEqual(calls.map((call) => call.pcmf32.length), [16000, 1600, 1600]);
  });

  it('shows nothing the child writes in ordinary use', TIMEOUT, async () => {
    const marker = `stand-in output ${process.pid}`;
    const host = startChild({ lines: [marker, 'info: using audio buffer as input'] });

    const seen = await watchStreams(marker, async () => {
      try {
        await host.ready();
        await host.loadModel(MODEL);
        await host.transcribe(Buffer.alloc(3200, 1), MODEL, false);
      } finally {
        host.stop();
      }
    });

    assert.deepStrictEqual(seen, []);
  });

  it('shows what the child writes with --debug, without the call markers', TIMEOUT, async () => {
    const marker = `stand-in output ${process.pid}`;
    const host = startChild({ lines: [marker] }, { debug: true });

    const seen = await watchStreams(marker, async () => {
      try {
        await host.ready();
        await host.loadModel(MODEL);
        await host.transcribe(Buffer.alloc(3200, 1), MODEL, false);
      } finally {
        host.stop();
      }
    });

    // The child writes the line once for the load and once for the call.
    const shown = seen.map((write) => write.text).join('');
    assert.strictEqual(shown.split(marker).length - 1, 2, `the child's lines were shown: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((write) => write.stream === 'err'));
    assert.ok(seen.every((write) => !write.text.includes('voxagent-call-end')));
  });

  it('rejects a load that failed, carrying what the child wrote', TIMEOUT, async () => {
    const host = startChild({ lines: LOAD_FAILURE, empty: true });

    try {
      await host.ready();
      await assert.rejects(host.loadModel(MODEL), (err) => {
        assert.match(err.message, /whisper_model_load: ERROR not all tensors loaded/);
        assert.match(err.message, /error: failed to initialize whisper context/);
        return true;
      });
    } finally {
      host.stop();
    }
  });

  it('rejects a call whose inference failed', TIMEOUT, async () => {
    const host = startChild({ lines: ['failed to process audio'], empty: true });

    try {
      await host.ready();
      await assert.rejects(host.transcribe(Buffer.alloc(3200, 1), MODEL, false), /failed to process audio/);
    } finally {
      host.stop();
    }
  });

  it('resolves a call whose output reports only a problem whisper recovers from', TIMEOUT, async () => {
    const host = startChild({ lines: ['whisper_backend_init_gpu: failed to initialize Metal backend', 'ggml_metal_init: error: metal library is nil'] });

    try {
      await host.ready();
      await host.loadModel(MODEL);
      assert.strictEqual(await host.transcribe(Buffer.alloc(3200, 1), MODEL, false), 'stub transcript');
    } finally {
      host.stop();
    }
  });

  it('reports why the child could not load the whisper addon', TIMEOUT, async () => {
    const host = startChild({ unloadable: 'the stand-in binary refuses to load' });

    try {
      await assert.rejects(host.ready(), /the stand-in binary refuses to load/);
    } finally {
      host.stop();
    }
  });

  it('sends the audio to the child through its standard input and writes no file on the way', TIMEOUT, async () => {
    const workDir = fs.mkdtempSync(path.join(dir, 'cwd-'));
    const childLog = path.join(dir, 'child-fs');
    const cwd = process.cwd();
    const audio = Buffer.alloc(32000, 3);
    const parentSpy = fsSpy.install();
    let beforeTranscribe;
    let afterTranscribe;
    let parentWrites;
    let host;

    // The child's working directory is inherited, so a recording written by the
    // positive control below lands in the work directory.
    process.chdir(workDir);

    try {
      host = startChild({}, { preload: [helper('fs-spy')], env: { VOXAGENT_TEST_FS_LOG: childLog } });
      await host.ready();
      await host.loadModel(MODEL);

      beforeTranscribe = counts.stdinBytes;
      const writesBefore = parentSpy.pathWrites().length;

      for (let i = 0; i < 3; i++) {
        await host.transcribe(audio, MODEL, false);
      }

      afterTranscribe = counts.stdinBytes;
      parentWrites = parentSpy.pathWrites().slice(writesBefore);

      // The positive control: a call asked to write its recording, so the child's
      // instrument must see a file written.
      await host.transcribe(audio, MODEL, true);
    } finally {
      parentSpy.restore();
      if (host) {
        host.stop();
      }
      process.chdir(cwd);
    }

    // The child writes its record as it exits.
    const deadline = Date.now() + 10000;
    let childRecord = null;

    while (!childRecord && Date.now() < deadline) {
      const file = fs.readdirSync(dir).find((name) => name.startsWith('child-fs.') && name.endsWith('.json'));
      if (file) {
        childRecord = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    assert.ok(childRecord, 'the child wrote its record of filesystem calls');

    const childPathWrites = childRecord.calls.filter((call) => call.kind === 'path');
    const debugWrites = childPathWrites.filter((call) => call.target.endsWith('debug-capture.wav'));
    const otherWrites = childPathWrites.filter((call) => !call.target.endsWith('debug-capture.wav'));

    // Three calls of audio plus a four byte length and a short JSON header each.
    const sent = afterTranscribe - beforeTranscribe;
    assert.ok(sent >= 3 * audio.length && sent < 3 * audio.length + 3 * 200, `${sent} bytes went to the child for ${3 * audio.length} bytes of audio`);
    assert.deepStrictEqual(parentWrites, []);
    assert.deepStrictEqual(otherWrites, []);
    assert.ok(debugWrites.length > 0, 'the positive control write was seen');
    assert.ok(fs.existsSync(path.join(workDir, 'debug-capture.wav')));
  });
});
