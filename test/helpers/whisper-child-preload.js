'use strict';

// Loaded with --require in the transcription child that lib/whisper.js forks, by
// way of NODE_OPTIONS. It puts a stand-in in place of the native whisper binary,
// so the child runs its real code over a whisper function that needs no model.
// VOXAGENT_TEST_WHISPER holds JSON that sets what the stand-in writes and returns:
//
//   lines       lines written to file descriptor 2 on every call, as the addon does
//   text        the transcript returned
//   empty       return no segments, as the addon does when it has no model
//   unloadable  a message the whisper function throws as it is loaded
//   log         a file each call is appended to, as one JSON object per line
//
// The first line of the log records the library search path variables the child
// was started with, which is what the dynamic loader would read.

const fs = require('fs');

const { stubModule, whisperBinaryPath } = require('./modules');

const config = JSON.parse(process.env.VOXAGENT_TEST_WHISPER || '{}');

// Kept from before any other preload can wrap it.
const appendFileSync = fs.appendFileSync;

function record(entry) {
  if (config.log) {
    appendFileSync(config.log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
  }
}

function whisper(params, callback) {
  const { pcmf32, ...options } = params;

  record({
    keys: Object.keys(params),
    options,
    pcmf32: { type: pcmf32 && pcmf32.constructor.name, length: pcmf32 ? pcmf32.length : 0 },
  });

  for (const line of config.lines || []) {
    fs.writeSync(2, `${line}\n`);
  }

  setImmediate(() => {
    const transcription = config.empty ? [] : [['00:00:00.000', '00:00:02.000', config.text || ' stub transcript']];
    callback(null, { transcription });
  });
}

const exportsOfBinary = {};

Object.defineProperty(exportsOfBinary, 'whisper', {
  enumerable: true,
  get() {
    if (config.unloadable) {
      throw new Error(config.unloadable);
    }
    return whisper;
  },
});

stubModule(whisperBinaryPath(process.platform, process.arch), exportsOfBinary);
record({
  event: 'preloaded',
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH === undefined ? null : process.env.LD_LIBRARY_PATH,
  DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH === undefined ? null : process.env.DYLD_LIBRARY_PATH,
});
