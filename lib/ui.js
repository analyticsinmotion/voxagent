'use strict';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

const CTRL_C = 0x03;

// Keys
//
// One listener reads standard input from startReadingKeys() until restoreTerminal(),
// with a terminal in raw mode for that whole time. Raw mode is what lets a single key
// press be seen without a line of input, and it means the terminal raises no interrupt
// of its own, so Ctrl+C arrives here as a byte at any point, whether or not a key is
// awaited, and is handed to the process interrupt handling that releases the
// microphone and stops the transcription child.
//
// A key press ends the wait that is active when it arrives. A key press that arrives
// while no wait is active, such as one made while voxagent transcribes or answers, is
// read and discarded at once. Input is never left unread between waits, where the
// operating system would hold it and hand it to the next wait as a fresh press.

// The stream the listener is attached to, while it reads.
let keyInput = null;

// The wait the next key press ends, as { wait, resolve }, or null when none is active.
let active = null;

function onKeyData(data) {
  if (data.includes(CTRL_C)) {
    process.stdout.write('\n');
    process.emit('SIGINT');
    return;
  }

  if (!active) {
    return;
  }

  const { wait, resolve } = active;

  active = null;
  wait.key = data.toString('utf8');
  resolve('key');
}

// Starts reading keys and puts a terminal in raw mode. Does nothing while keys are
// already being read.
function startReadingKeys() {
  if (keyInput) {
    return;
  }

  const stdin = process.stdin;

  keyInput = stdin;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  stdin.on('data', onKeyData);
  stdin.resume();
}

// Waits for one key press and can be cancelled. The promise resolves with 'key' when a
// key press ends the wait, and key then holds the text of that press, such as '\r' for
// ENTER or 'h' for H. It resolves with 'cancelled' when cancel() ends the wait first.
// Starting a wait cancels any wait still active, so one key press ends one wait.
function waitForKey() {
  startReadingKeys();

  if (active) {
    active.wait.cancel();
  }

  let resolve;
  const wait = {
    promise: new Promise((r) => {
      resolve = r;
    }),
    key: null,
    cancel() {
      if (active && active.wait === wait) {
        active = null;
        resolve('cancelled');
      }
    },
  };

  active = { wait, resolve };

  return wait;
}

// Stops reading keys, takes the terminal out of raw mode and pauses standard input.
// Safe to call on any exit path, including one where no key was ever read.
function restoreTerminal() {
  if (active) {
    active.wait.cancel();
  }

  try {
    const stdin = keyInput || process.stdin;

    if (keyInput) {
      keyInput.removeListener('data', onKeyData);
      keyInput = null;
    }

    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }

    stdin.pause();
  } catch (err) {
    // The terminal is already in the state this asks for.
  }
}

function print(msg) {
  process.stdout.write(msg + '\n');
}

function printError(msg) {
  process.stdout.write(`${RED}Error: ${msg}${RESET}\n`);
}

function printTranscript(text) {
  process.stdout.write(`\n${GREEN}You:${RESET} ${text}\n`);
}

function printResponse(text) {
  process.stdout.write(`\n${text}\n`);
}

function printStatus(msg) {
  process.stdout.write(`${DIM}${msg}${RESET}\n`);
}

function printBanner(version) {
  process.stdout.write(`\n${CYAN}voxagent${RESET} v${version} - voice-powered terminal\n\n`);
}

module.exports = {
  startReadingKeys,
  waitForKey,
  restoreTerminal,
  print,
  printError,
  printTranscript,
  printResponse,
  printStatus,
  printBanner,
};
