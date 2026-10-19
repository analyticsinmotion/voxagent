'use strict';

// Run as a child process by the key tests, with a pipe on its standard input. It makes
// the key waits of one turn of the interactive loop through lib/ui.js: the wait at the
// prompt, which the parent ends by writing ENTER, the wait for the stop key during a
// recording, which is cancelled when the recording ends by itself, a busy period of
// BUSY_MS, as voxagent spends transcribing and answering, in which the parent writes a
// key, and the wait at the next prompt. It writes the result of that last wait to
// standard output as one line of JSON: how the wait ended, the key that ended it, and
// how many milliseconds after the wait began. Each step is announced on standard output
// before the parent acts on it.

const { lib } = require('./repo');

const { waitForKey } = require(lib('ui'));

const RECORDING_MS = 100;
const BUSY_MS = 500;
const GIVE_UP_MS = 5000;

const say = (line) => process.stdout.write(`${line}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const prompt = waitForKey();
  say('waiting at the prompt');
  await prompt.promise;

  const stopKey = waitForKey();
  await delay(RECORDING_MS);
  stopKey.cancel();
  await stopKey.promise;

  say('busy');
  await delay(BUSY_MS);

  const started = Date.now();
  const next = waitForKey();
  const timer = setTimeout(() => next.cancel(), GIVE_UP_MS);
  say('waiting at the next prompt');

  const reason = await next.promise;
  clearTimeout(timer);

  say(JSON.stringify({ reason, key: next.key === undefined ? null : next.key, afterMs: Date.now() - started }));
  process.exit(0);
}

main();
