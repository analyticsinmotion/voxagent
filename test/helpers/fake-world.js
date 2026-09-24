'use strict';

// Loaded with --require before bin/voxagent.js, so that the whole program runs
// against stand-ins: decibri's Microphone and File, the Ollama client, the whisper
// model download and the transcription child. What each stand-in does comes from
// the JSON in VOXAGENT_TEST_WORLD, and every call is appended to the log file it
// names, one JSON object per line.
//
//   log         the file each event is appended to
//   file        { speech, bytes } for a file that opens, or { error: { code, message } }
//   microphone  { speech } for a recording that detects speech and ends on silence,
//               or detects none and ends when ENTER is pressed
//   ollama      { models, answer }
//   whisper     { text }
//   keys        with a value, input looks like a terminal, and each key is pressed
//               when voxagent next asks for one: "enter", "ctrl-c" or "none"
//   platform    { platform, arch } for process.platform and process.arch to report

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { stubModule, LIB } = require('./modules');

const world = JSON.parse(process.env.VOXAGENT_TEST_WORLD);

function note(event, detail) {
  fs.appendFileSync(world.log, `${JSON.stringify({ event, ...detail })}\n`);
}

const CHUNK = 3200;

function stream() {
  const source = new EventEmitter();
  source.destroyed = false;
  source.readableEnded = false;
  return source;
}

// decibri

const microphone = {
  async open(options) {
    note('microphone.open', { options });

    const mic = stream();
    const timers = [];
    let sent = 0;

    const send = () => {
      mic.emit('data', Buffer.alloc(CHUNK, 1));
      sent += CHUNK;
    };

    mic.stop = () => {
      note('microphone.stop', { sent });
      for (const timer of timers) {
        clearInterval(timer);
      }
      setImmediate(() => mic.emit('end'));
    };

    setImmediate(() => {
      if (world.microphone && world.microphone.speech) {
        // Twelve chunks of speech, which is more than the one second a recording
        // needs, then silence, which ends the recording.
        send();
        mic.emit('speech');
        for (let i = 1; i < 12; i++) {
          send();
        }
        mic.emit('silence');
        return;
      }

      // No speech is ever detected. The same twelve chunks arrive at once, which is
      // more than the one second a recording needs to reach whisper, and audio
      // keeps arriving until the recording is stopped.
      for (let i = 0; i < 12; i++) {
        send();
      }
      timers.push(setInterval(send, 20));
    });

    return mic;
  },
};

const file = {
  async open(filePath, options) {
    note('file.open', { filePath, options });

    const settings = world.file || {};

    if (settings.error) {
      throw Object.assign(new Error(settings.error.message), { code: settings.error.code });
    }

    const source = stream();

    source.close = () => note('file.close');

    source.on('newListener', (event) => {
      if (event !== 'data') {
        return;
      }

      setImmediate(() => {
        const total = settings.bytes || 0;

        for (let sent = 0; sent < total; sent += CHUNK) {
          if (sent === 0 && settings.speech) {
            source.emit('speech');
          }
          source.emit('data', Buffer.alloc(Math.min(CHUNK, total - sent), 1));
        }

        source.emit('end');
      });
    });

    return source;
  },
};

stubModule('decibri', {
  Microphone: microphone,
  File: file,
  inputDevices: () => world.devices || [],
});

// Ollama

class FakeOllama {
  constructor(config) {
    note('ollama.construct', { host: config && config.host });
  }

  async list() {
    note('ollama.list');
    return { models: (world.ollama.models || []).map((name) => ({ name, model: name })) };
  }

  async generate(request) {
    note('ollama.generate', { model: request.model });
    return { response: '', done: true };
  }

  async chat(request) {
    note('ollama.chat', { model: request.model, content: request.messages[0].content });
    return { message: { role: 'assistant', content: world.ollama.answer } };
  }
}

stubModule('ollama', { Ollama: FakeOllama });

// The whisper model and the transcription child

const MODEL_PATH = path.join(__dirname, 'no-such-model.bin');

stubModule(path.join(LIB, 'model.js'), {
  getModelPath: () => MODEL_PATH,
  ensureModel: async () => {
    note('model.ensure');
    return MODEL_PATH;
  },
});

// The platform check reads where the addon's binaries are from lib/whisper.js, so the
// stand-in keeps those two functions from the real module.
const { whisperDist, whisperBinary } = require(path.join(LIB, 'whisper.js'));

stubModule(path.join(LIB, 'whisper.js'), {
  whisperDist,
  whisperBinary,
  start(options) {
    note('whisper.start', { debug: options.debug });

    return {
      async ready() {
        note('whisper.ready');
      },
      async loadModel(modelPath) {
        note('whisper.load', { modelPath });
      },
      async transcribe(audio, modelPath, debug) {
        note('whisper.transcribe', { bytes: audio.length, debug });
        return world.whisper.text;
      },
      stop() {
        note('whisper.stop');
      },
    };
  },
});

// The platform

// The standard streams are created before process.platform changes, because Node
// creates each on first use and chooses from the platform whether a pipe is written
// synchronously, and output written asynchronously is lost when the process exits.
if (world.platform) {
  process.stdout;
  process.stderr;
  Object.defineProperty(process, 'platform', { value: world.platform.platform });
  Object.defineProperty(process, 'arch', { value: world.platform.arch });
}

// A terminal

if (world.keys) {
  const keys = [...world.keys];
  const realWrite = process.stdout.write.bind(process.stdout);
  const BYTES = { enter: 0x0d, 'ctrl-c': 0x03 };

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  process.stdin.setRawMode = (on) => {
    note('terminal.raw', { on });
    return process.stdin;
  };

  // voxagent asks for a key at the prompt and while it records.
  process.stdout.write = (chunk, ...rest) => {
    const text = String(chunk);

    if (text.includes('Press ENTER to speak') || text.includes('Recording. It stops')) {
      const key = keys.shift();

      if (key && key !== 'none') {
        setTimeout(() => {
          note('terminal.key', { key });
          process.stdin.emit('data', Buffer.from([BYTES[key]]));
        }, 30);
      }
    }

    return realWrite(chunk, ...rest);
  };
}

process.on('exit', (code) => note('exit', { code }));
