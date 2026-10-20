'use strict';

// Run as a child process by the exit path tests. Starts reading keys with standard
// input made to look like a terminal, opens a stand-in microphone through the shipped
// cleanup registration, and then takes the exit path named in argv[2]: sigint, sigterm
// and sigbreak emit that signal event, uncaught throws an exception nothing catches, and
// exit calls process.exit. Each raw mode change is appended to the file in argv[3] as
// "raw true" or "raw false", and the stand-in microphone appends "stop" when it is
// stopped, so the parent can see whether the microphone was released and the terminal
// taken out of raw mode before the process ended.

const { EventEmitter } = require('events');
const fs = require('fs');

const { stubModule } = require('./modules');
const { BIN, lib } = require('./repo');

const [mode, log] = process.argv.slice(2);

const record = (line) => fs.appendFileSync(log, `${line}\n`);

Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = (on) => {
  record(`raw ${on}`);
  return process.stdin;
};

stubModule('decibri', {
  Microphone: { open: async () => { throw new Error('the default engine is not used here'); } },
  File: { open: async () => { throw new Error('the default engine is not used here'); } },
  inputDevices: () => [],
});

const cli = require(BIN);

// Loading capture through the entry point puts it where the shipped cleanup looks.
const capture = cli.loadCapture();

const engine = {
  async open() {
    const mic = new EventEmitter();
    mic.destroyed = false;
    mic.readableEnded = false;
    mic.stop = () => record('stop');
    setImmediate(() => mic.emit('data', Buffer.alloc(3200)));
    return mic;
  },
};

cli.registerCleanup();

// Keys are read from here on, as in the interactive loop, which puts the terminal in raw
// mode until an exit path takes it out.
require(lib('ui')).startReadingKeys();

// A recording that never ends by itself, so a microphone is open when the exit
// path is taken.
capture.record({ engine, noSpeechMs: 600000, maxRecordingMs: 600000 }).catch(() => {});

setTimeout(() => {
  record(`trigger ${mode}`);

  if (mode === 'sigint') {
    process.emit('SIGINT');
  } else if (mode === 'sigterm') {
    process.emit('SIGTERM');
  } else if (mode === 'sigbreak') {
    process.emit('SIGBREAK');
  } else if (mode === 'uncaught') {
    setImmediate(() => {
      throw new Error('an exception nothing catches');
    });
  } else if (mode === 'exit') {
    process.exit(0);
  }

  // A process still running here did not exit on the path it was given.
  setTimeout(() => {
    record('still running');
    process.exit(3);
  }, 2000);
}, 200);
