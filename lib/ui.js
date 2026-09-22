'use strict';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

const CTRL_C = 0x03;

// Waits for a key press and can be cancelled. Cancelling removes the listener and
// takes the terminal out of raw mode at once, which is what stops a recording that
// ended by itself from leaving a listener behind to swallow the next press.
//
// Raw mode is what lets a single press of ENTER be seen without a line of input,
// and it also means the terminal does not raise an interrupt of its own, so
// Ctrl+C arrives here as a byte and is handed to the process interrupt handling
// that releases the microphone.
function waitForKey() {
  const stdin = process.stdin;
  let settled = false;
  let onData = null;
  let resolve;

  const promise = new Promise((r) => {
    resolve = r;
  });

  const release = () => {
    if (onData) {
      stdin.removeListener('data', onData);
      onData = null;
    }

    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }

    stdin.pause();
  };

  onData = (key) => {
    if (settled) {
      return;
    }

    settled = true;
    release();

    if (key[0] === CTRL_C) {
      process.stdout.write('\n');
      process.emit('SIGINT');
      return;
    }

    resolve('key');
  };

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  // Anything typed before this wait began belongs to whatever came before it, so
  // it is discarded rather than taken as a press of ENTER now.
  while (stdin.read() !== null) {
    // discarded
  }

  stdin.on('data', onData);
  stdin.resume();

  return {
    promise,
    cancel() {
      if (settled) {
        return;
      }

      settled = true;
      release();
      resolve('cancelled');
    },
  };
}

// Takes the terminal out of raw mode and stops reading it. Safe to call on any
// exit path, including one where no key was being waited for.
function restoreTerminal() {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
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
  waitForKey,
  restoreTerminal,
  print,
  printError,
  printTranscript,
  printResponse,
  printStatus,
  printBanner,
};
