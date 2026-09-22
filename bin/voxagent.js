#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');

const { waitForKey, print, printError, printTranscript, printResponse, printStatus, printBanner } = require('../lib/ui');
const { ensureModel } = require('../lib/model');
const { checkConnection, hasModel, loadModel: loadLanguageModel, ask, DEFAULT_MODEL } = require('../lib/llm');

const VERSION = require('../package.json').version;

const WHISPER_PACKAGE = '@kutalia/whisper-node-addon';

const VC_REDIST_URL = {
  arm64: 'https://aka.ms/vs/17/release/vc_redist.arm64.exe',
  x64: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
};

const OPTIONS = {
  model: { type: 'string' },
  device: { type: 'string' },
  'list-devices': { type: 'boolean' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const USAGE = `
Usage: voxagent [options]

Voice-powered terminal agent. Fully offline.

Options:
  --model <name>            Ollama model to use (default: ${DEFAULT_MODEL})
  --device <id-or-name>     Input device to record from (default: the system default)
  --list-devices            List the available input devices and exit
  --debug                   Save each recording to debug-capture.wav in the current directory
  --help, -h                Show this help message
  --version, -v             Show version number
`;

// Arguments

function usageError(message) {
  printError(message);
  print('Run voxagent --help for usage.');
  process.exit(2);
}

// parseArgs reports each kind of mistake with its own code and a message that already
// names the option. The one exception is an option value that itself looks like an
// option, whose built-in message runs to three lines, so that case is reworded.
function argumentErrorMessage(err) {
  const firstLine = String(err.message).split('\n')[0].trim();

  if (err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && firstLine.endsWith('argument is ambiguous.')) {
    const named = firstLine.match(/'([^']+)'/);
    return `Option ${named ? `'${named[1]}'` : 'given'} requires a value.`;
  }

  return firstLine;
}

// parseArgs accepts an empty value from --model= and a dash-led value from --model=-x,
// so both are rejected here. Either one means the value was left out.
function requireValue(values, name) {
  const value = values[name];

  if (value === undefined) {
    return undefined;
  }

  if (value === '' || value.startsWith('-')) {
    usageError(`Option '--${name}' requires a value.`);
  }

  return value;
}

function parseCommandLine(argv) {
  let parsed;

  try {
    parsed = parseArgs({ args: argv.slice(2), options: OPTIONS, strict: true, allowPositionals: false });
  } catch (err) {
    usageError(argumentErrorMessage(err));
  }

  const values = parsed.values;

  if (values.help) {
    console.log(USAGE.trim());
    process.exit(0);
  }

  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  return {
    model: requireValue(values, 'model') || DEFAULT_MODEL,
    device: requireValue(values, 'device'),
    listDevices: values['list-devices'] === true,
    debug: values.debug === true,
  };
}

// Native modules

// The whisper addon resolves its binary as <package>/dist/<platform>-<arch>/whisper.node
// from the values process.platform and process.arch report, and it does that while it is
// being required. These are the pairs it ships a binary for under a name that resolution
// can reach. require.resolve locates the package without running it.
function whisperTargets() {
  const dist = path.join(path.dirname(require.resolve(WHISPER_PACKAGE)), '..');
  const targets = [];

  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      if (fs.existsSync(path.join(dist, `${platform}-${arch}`, 'whisper.node'))) {
        targets.push(`${platform}-${arch}`);
      }
    }
  }

  return targets;
}

function checkWhisperPlatform(platform, arch) {
  const targets = whisperTargets();

  if (targets.includes(`${platform}-${arch}`)) {
    return;
  }

  printError(`voxagent does not support ${platform} on ${arch}.`);
  print(`Supported platforms: ${targets.join(', ')}.`);
  process.exit(1);
}

// A native module whose own file is present but whose imported library is missing fails
// with ERR_DLOPEN_FAILED and the text below. A module file that is itself absent fails
// with the same code and the same text, so the path the error names is checked to tell
// the two apart. The load error may be wrapped, so the cause chain is walked.
function missingLibraryError(err) {
  let depth = 0;

  for (let current = err; current && depth < 16; current = current.cause, depth++) {
    if (current.code !== 'ERR_DLOPEN_FAILED') {
      continue;
    }

    const message = String(current.message);

    if (!message.includes('The specified module could not be found')) {
      continue;
    }

    const lines = message.trim().split(/\r?\n/);
    const named = lines[lines.length - 1];

    if (named && fs.existsSync(named)) {
      return current;
    }
  }

  return null;
}

function reportNativeLoadFailure(err) {
  if (process.platform === 'win32' && missingLibraryError(err)) {
    printError('A native module could not load because a library it needs is missing.');
    print('voxagent needs the Microsoft Visual C++ Redistributable on Windows.');
    print(`Install it from ${VC_REDIST_URL[process.arch] || VC_REDIST_URL.x64}`);
    process.exit(1);
  }

  printError(err.message);
  process.exit(1);
}

// decibri and the whisper addon are loaded here rather than at the top of the file, so
// that --help, --version and every argument error work on a machine where neither
// native module can load.
function loadCapture() {
  try {
    return require('../lib/capture');
  } catch (err) {
    reportNativeLoadFailure(err);
  }
}

function loadStt() {
  checkWhisperPlatform(process.platform, process.arch);

  try {
    return require('../lib/stt');
  } catch (err) {
    reportNativeLoadFailure(err);
  }
}

// Devices

function printDevices() {
  const devices = loadCapture().listDevices();

  if (devices.length === 0) {
    print('No input devices found.');
    return;
  }

  for (const device of devices) {
    print(`${device.isDefault ? '*' : ' '} ${device.name} (${device.maxInputChannels} channels, ${device.defaultSampleRate} Hz)`);
    print(`    ${device.id}`);
  }

  print('');
  print('The device marked * is the system default. Pass a name or an id to --device.');
}

function resolveRequestedDevice(selector) {
  const capture = loadCapture();
  const matches = capture.resolveDevice(selector, capture.listDevices());

  if (matches.length === 0) {
    printError(`No input device matched '${selector}'.`);
    print('Run voxagent --list-devices to see the available devices.');
    process.exit(1);
  }

  if (matches.length > 1) {
    printError(`More than one input device matched '${selector}'.`);
    print('Choose one by passing its id to --device:');
    for (const device of matches) {
      print(`  ${device.name}`);
      print(`    ${device.id}`);
    }
    process.exit(1);
  }

  return matches[0];
}

// Main

async function main() {
  const { model, device, listDevices, debug } = parseCommandLine(process.argv);

  if (listDevices) {
    printDevices();
    return;
  }

  printBanner(VERSION);

  // The device is resolved first, so that a selector naming no device, or more than one,
  // fails before any model is checked or loaded.
  let selectedDevice;
  if (device !== undefined) {
    selectedDevice = resolveRequestedDevice(device);
    printStatus(`Recording from ${selectedDevice.name}.`);
  }

  // Preflight: check Ollama
  printStatus('Checking Ollama connection...');
  if (!(await checkConnection())) {
    printError('Ollama is not running. Start it with: ollama serve');
    printError('Install Ollama from https://ollama.com');
    process.exit(1);
  }
  printStatus('Ollama connected.');

  let modelPresent;
  try {
    modelPresent = await hasModel(model);
  } catch (err) {
    printError(`Failed to list Ollama models: ${err.message}`);
    process.exit(1);
  }

  if (!modelPresent) {
    printError(`Ollama model '${model}' is not installed.`);
    print(`Fetch it with: ollama pull ${model}`);
    process.exit(1);
  }

  // Loading here pays the model read before the first prompt, so the first answer costs
  // no more than any later one.
  printStatus(`Loading ${model}...`);
  try {
    await loadLanguageModel(model);
  } catch (err) {
    printError(`Failed to load ${model}: ${err.message}`);
    process.exit(1);
  }
  printStatus(`${model} ready.`);

  // Preflight: ensure whisper model
  printStatus('Checking whisper model...');
  let modelPath;
  try {
    modelPath = await ensureModel();
  } catch (err) {
    printError(`Failed to set up whisper model: ${err.message}`);
    process.exit(1);
  }

  const { transcribe, loadModel } = loadStt();

  // Loading here pays the model read and the backend initialisation before the first
  // prompt, so the first transcription costs no more than any later one.
  printStatus('Loading whisper model...');
  try {
    await loadModel(modelPath);
  } catch (err) {
    printError(`Failed to load whisper model: ${err.message}`);
    process.exit(1);
  }
  printStatus('Whisper model ready.');

  const { startCapture, stopCapture } = loadCapture();

  print('');

  // Main loop
  while (true) {
    print('Press ENTER to speak, or Ctrl+C to quit.');
    await waitForKey();

    print('[Recording...] Press ENTER to stop.');
    const handle = startCapture(selectedDevice);
    await waitForKey();
    const pcmBuffer = stopCapture(handle);

    const durationSec = (pcmBuffer.length / 2 / 16000).toFixed(1);
    printStatus(`Captured ${durationSec}s of audio (${pcmBuffer.length} bytes)`);

    // Check minimum recording length (~1 second at 16kHz 16-bit mono)
    if (pcmBuffer.length < 32000) {
      print('Recording too short. Try again.\n');
      continue;
    }

    try {
      printStatus('Transcribing...');
      const text = await transcribe(pcmBuffer, modelPath, debug);

      if (!text || !text.trim()) {
        print('No speech detected.\n');
        continue;
      }

      printTranscript(text);

      printStatus('\nThinking...');
      const response = await ask(text, model);
      printResponse(response);
      print('');
    } catch (err) {
      printError(err.message);
      print('');
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    printError(err.message);
    process.exit(1);
  });
}

module.exports = {
  USAGE,
  OPTIONS,
  VERSION,
  parseCommandLine,
  whisperTargets,
  checkWhisperPlatform,
  missingLibraryError,
};
