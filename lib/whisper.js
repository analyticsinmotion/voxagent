'use strict';

const { fork } = require('child_process');
const fs = require('fs');

// whisper writes its diagnostics from native code straight to the process file
// descriptors, so neither an option on the addon nor replacing the JavaScript
// write can hide them. Transcription therefore runs in a child process, and this
// module is both sides of it. The parent captures the child's standard streams
// and decides what to show. The child loads the model once and keeps it loaded,
// so only the first call pays the model read.
//
// Each request is framed on the child's standard input as a four-byte big-endian
// header length, that many bytes of JSON header, and then the raw audio. Replies
// travel over the inter-process channel, so the reply never mixes with whisper's
// own output. The child writes a marker to file descriptor 2 before it sends a
// reply, which is what tells the parent where one call's output ends.

const MARKER_PREFIX = '<<<voxagent-call-end:';
const MARKER = (id) => `${MARKER_PREFIX}${id}>>>`;

// whisper reports a model it cannot load by printing an error line and then
// resolving the call with an empty result, so the output is the only signal that
// the call failed. No line whisper prints in ordinary use contains this word.
const ERROR_LINE = /\berror\b/i;

const MARKER_WAIT_MS = 500;
const STOP_WAIT_MS = 2000;

function frame(header, payload) {
  const body = Buffer.from(JSON.stringify({ ...header, bytes: payload ? payload.length : 0 }), 'utf8');
  const length = Buffer.alloc(4);

  length.writeUInt32BE(body.length, 0);

  return payload ? Buffer.concat([length, body, payload]) : Buffer.concat([length, body]);
}

function errorLines(text) {
  return text.split(/\r?\n/).filter((line) => ERROR_LINE.test(line));
}

// The parent

function start(options) {
  const settings = options || {};
  const debug = settings.debug === true;
  const child = fork(__filename, [], { silent: true });

  const pending = new Map();
  let capturedOut = '';
  let capturedErr = '';
  let markerWaiters = [];
  let unavailable = null;
  let exit = null;
  let nextId = 1;

  const checkMarkers = () => {
    markerWaiters = markerWaiters.filter((waiter) => {
      if (capturedErr.includes(waiter.marker)) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  };

  child.stdout.on('data', (data) => {
    capturedOut += data.toString('utf8');
    if (debug) {
      process.stdout.write(data);
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString('utf8');
    capturedErr += text;
    if (debug) {
      // The markers are this module's own framing and are not whisper output, so
      // they are removed from what the user is shown.
      const shown = text.replace(new RegExp(`\\n?${MARKER_PREFIX}\\d+>>>\\n?`, 'g'), '');
      if (shown.length > 0) {
        process.stderr.write(shown);
      }
    }
    checkMarkers();
  });

  child.on('exit', (code, signal) => {
    exit = { code, signal };
    for (const waiter of markerWaiters) {
      waiter.resolve();
    }
    markerWaiters = [];
    for (const [, call] of pending) {
      call.reject(new Error(describeExit(code, signal, claimAll())));
    }
    pending.clear();
  });

  child.on('message', (message) => {
    if (message.type === 'unavailable') {
      unavailable = message.message;
      return;
    }

    const call = pending.get(message.id);

    if (!call) {
      return;
    }

    pending.delete(message.id);
    waitForMarker(message.id).then(() => call.settle(message));
  });

  const ready = new Promise((resolve) => {
    child.once('message', (message) => resolve(message));
    child.once('exit', () => resolve({ type: 'exit' }));
  });

  function describeExit(code, signal, output) {
    const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
    return output ? `Transcription ${how}.\n${output}` : `Transcription ${how}.`;
  }

  function claimAll() {
    const text = (capturedErr + capturedOut).trim();
    capturedErr = '';
    capturedOut = '';
    return text;
  }

  // Everything the child wrote up to the marker for this call, with the marker
  // removed. The marker is written before the reply is sent, so it bounds the
  // call exactly rather than by timing.
  function claim(id) {
    const marker = MARKER(id);
    const at = capturedErr.indexOf(marker);
    let text;

    if (at < 0) {
      text = capturedErr;
      capturedErr = '';
    } else {
      text = capturedErr.slice(0, at);
      capturedErr = capturedErr.slice(at + marker.length);
    }

    const out = capturedOut;
    capturedOut = '';

    return (text + out).trim();
  }

  function waitForMarker(id) {
    const marker = MARKER(id);

    if (capturedErr.includes(marker) || exit) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const waiter = { marker, resolve };
      markerWaiters.push(waiter);
      setTimeout(() => {
        markerWaiters = markerWaiters.filter((w) => w !== waiter);
        resolve();
      }, MARKER_WAIT_MS);
    });
  }

  function send(header, payload) {
    const id = nextId++;

    if (exit) {
      return Promise.reject(new Error(describeExit(exit.code, exit.signal, claimAll())));
    }

    return new Promise((resolve, reject) => {
      pending.set(id, {
        reject,
        settle: (message) => {
          const output = claim(id);
          const failures = errorLines(output);

          if (message.type === 'error') {
            reject(new Error(output ? `${message.message}\n${output}` : message.message));
            return;
          }

          if (failures.length > 0) {
            reject(new Error(output));
            return;
          }

          resolve(message);
        },
      });

      try {
        child.stdin.write(frame({ ...header, id }, payload));
      } catch (err) {
        pending.delete(id);
        reject(new Error(describeExit(exit ? exit.code : null, exit ? exit.signal : null, claimAll())));
      }
    });
  }

  return {
    // Resolves once the child is running, or rejects naming why the whisper
    // addon could not be loaded there.
    async ready() {
      const first = await ready;

      if (first.type === 'unavailable' || unavailable) {
        throw new Error(unavailable || first.message);
      }

      if (first.type !== 'ready') {
        throw new Error(describeExit(exit ? exit.code : null, exit ? exit.signal : null, claimAll()));
      }
    },

    async loadModel(modelPath) {
      await send({ type: 'load', model: modelPath });
    },

    async transcribe(audio, modelPath, wantsDebug) {
      const message = await send({ type: 'transcribe', model: modelPath, debug: wantsDebug === true }, audio);
      return message.text;
    },

    stop() {
      if (exit) {
        return;
      }

      try {
        child.stdin.end();
      } catch (err) {
        // The pipe is already closed, which is the state this asks for.
      }

      try {
        if (child.connected) {
          child.disconnect();
        }
      } catch (err) {
        // The channel is already closed, which is the state this asks for.
      }

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch (err) {
          // The child is already gone.
        }
      }, STOP_WAIT_MS);

      timer.unref();
      child.unref();
    },
  };
}

// The child

function runHost() {
  let stt;

  try {
    stt = require('./stt');
  } catch (err) {
    const message = String((err && err.message) || err);

    if (process.send) {
      process.send({ type: 'unavailable', message }, () => process.exit(1));
      return;
    }

    process.exit(1);
  }

  let buffered = Buffer.alloc(0);
  let queue = Promise.resolve();

  const reply = (message) => {
    // The marker is written first, so the parent knows where this call's output
    // ended before it sees the reply.
    fs.writeSync(2, `\n${MARKER(message.id)}\n`);

    if (process.send) {
      process.send(message);
    }
  };

  const handle = (header, payload) => {
    queue = queue.then(async () => {
      try {
        if (header.type === 'load') {
          await stt.loadModel(header.model);
          reply({ type: 'loaded', id: header.id });
          return;
        }

        const text = await stt.transcribe(payload, header.model, header.debug === true);
        reply({ type: 'result', id: header.id, text });
      } catch (err) {
        reply({ type: 'error', id: header.id, message: String((err && err.message) || err) });
      }
    });
  };

  process.stdin.on('data', (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

    for (;;) {
      if (buffered.length < 4) {
        return;
      }

      const headerLength = buffered.readUInt32BE(0);

      if (buffered.length < 4 + headerLength) {
        return;
      }

      const header = JSON.parse(buffered.toString('utf8', 4, 4 + headerLength));
      const total = 4 + headerLength + header.bytes;

      if (buffered.length < total) {
        return;
      }

      const payload = Buffer.from(buffered.subarray(4 + headerLength, total));

      buffered = Buffer.from(buffered.subarray(total));
      handle(header, payload);
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.on('disconnect', () => process.exit(0));

  if (process.send) {
    process.send({ type: 'ready' });
  }
}

if (require.main === module) {
  runHost();
}

module.exports = { start };
