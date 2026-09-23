'use strict';

// Stand-ins used in the test process itself: the native whisper function, a
// decibri stream, a terminal on standard input, and a filter that keeps
// lib/model.js's download lines out of the test output.

const { EventEmitter } = require('events');
const fs = require('fs');

// A stand-in for the native whisper function the addon exports. It records every
// params object it is called with, writes the given lines to file descriptor 2 as
// the addon does, and answers through the callback on a later turn, as the native
// function does.
function fakeWhisper(behaviour) {
  const settings = {
    text: ' stub transcript',
    lines: [],
    error: null,
    result: null,
    ...behaviour,
  };
  const calls = [];

  function whisper(params, callback) {
    calls.push(params);

    for (const line of settings.lines) {
      fs.writeSync(2, `${line}\n`);
    }

    setImmediate(() => {
      if (settings.error) {
        callback(settings.error);
        return;
      }

      callback(null, settings.result || { transcription: [['00:00:00.000', '00:00:02.000', settings.text]] });
    });
  }

  whisper.calls = calls;
  return whisper;
}

// A stand-in for a decibri stream, driven by hand. stop() records the call and runs
// the given onStop, which is how a test has the stream deliver its tail and end.
function fakeStream(behaviour) {
  const stream = new EventEmitter();
  const settings = { onStop: null, ...behaviour };

  stream.destroyed = false;
  stream.readableEnded = false;
  stream.stopCalls = 0;
  stream.closeCalls = 0;

  stream.stop = () => {
    stream.stopCalls += 1;
    if (settings.onStop) {
      settings.onStop(stream);
    }
  };

  stream.close = () => {
    stream.closeCalls += 1;
  };

  return stream;
}

// An engine whose open() records the options it was given and resolves with a
// fake stream, then runs onOpen with that stream on a later turn.
function fakeEngine(behaviour) {
  const settings = { onOpen: null, onStop: null, failWith: null, ...behaviour };
  const engine = { opened: [], streams: [] };

  engine.open = async (...args) => {
    engine.opened.push(args);

    if (settings.failWith) {
      throw settings.failWith;
    }

    const stream = fakeStream({ onStop: settings.onStop });
    engine.streams.push(stream);

    if (settings.onOpen) {
      setImmediate(() => settings.onOpen(stream));
    }

    return stream;
  };

  return engine;
}

// Replaces process.stdin with a stand-in terminal for the length of a test, so a
// key wait can be exercised without reading real input. Records every raw mode
// change and exposes the data listener count.
function installFakeStdin() {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdin = new EventEmitter();

  stdin.isTTY = true;
  stdin.rawModes = [];
  stdin.setRawMode = (on) => {
    stdin.rawModes.push(on);
    return stdin;
  };
  stdin.read = () => null;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;

  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => stdin,
  });

  return {
    stdin,
    restore() {
      Object.defineProperty(process, 'stdin', descriptor);
    },
  };
}

// Keeps the lines lib/model.js writes during a download out of the test output and
// collects them, passing every other write through untouched.
function captureModelOutput() {
  const realWrite = process.stdout.write;
  const lines = [];
  const prefixes = ['\rDownloading whisper model', 'Downloading base.en', 'Whisper model ', 'Model downloaded'];

  process.stdout.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' && prefixes.some((prefix) => chunk.startsWith(prefix))) {
      lines.push(chunk);
      return true;
    }

    return realWrite.call(this, chunk, ...rest);
  };

  return {
    lines,
    restore() {
      process.stdout.write = realWrite;
    },
  };
}

module.exports = { fakeWhisper, fakeStream, fakeEngine, installFakeStdin, captureModelOutput };
