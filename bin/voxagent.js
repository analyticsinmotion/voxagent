#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseArgs } = require('node:util');

const { waitForKey, restoreTerminal, print, printError, printTranscript, printResponse, printStatus, printBanner } = require('../lib/ui');
const { ensureModel } = require('../lib/model');
const { checkConnection, hasModel, loadModel: loadLanguageModel, ask, DEFAULT_MODEL } = require('../lib/llm');
const { whisperDist, whisperBinary } = require('../lib/whisper');

const VERSION = require('../package.json').version;

const VC_REDIST_URL = {
  arm64: 'https://aka.ms/vs/17/release/vc_redist.arm64.exe',
  x64: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
};

// System libraries the whisper addon's Linux build needs and does not ship, with the
// Debian and Ubuntu package that provides each.
const LINUX_SYSTEM_LIBRARIES = {
  'libgomp.so.1': { description: 'the GNU OpenMP runtime', pkg: 'libgomp1' },
  'libvulkan.so.1': { description: 'the Vulkan loader', pkg: 'libvulkan1' },
};

const OPTIONS = {
  model: { type: 'string' },
  device: { type: 'string' },
  'list-devices': { type: 'boolean' },
  file: { type: 'string' },
  denoise: { type: 'boolean' },
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
  --file <path>             Answer one question recorded in an audio file, then exit
  --denoise                 Reduce background noise before transcription
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

  const settings = {
    model: requireValue(values, 'model') || DEFAULT_MODEL,
    device: requireValue(values, 'device'),
    file: requireValue(values, 'file'),
    listDevices: values['list-devices'] === true,
    denoise: values.denoise === true,
    debug: values.debug === true,
  };

  // --file reads its audio from the file and never opens a microphone, so a device
  // given alongside it would be ignored in silence.
  if (settings.file !== undefined && settings.device !== undefined) {
    usageError("Options '--file' and '--device' cannot be combined.");
  }

  return settings;
}

// Native modules

// The pairs with a binary at the path their loader uses.
function whisperTargets() {
  const dist = whisperDist();
  const targets = [];

  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      const binary = whisperBinary(dist, platform, arch);

      if (binary && fs.existsSync(binary)) {
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

// On Linux the dynamic loader reports the first library it cannot find as
// "<name>: cannot open shared object file: No such file or directory". Returns the
// entry for that library when it is one of the system libraries above, or null. The
// load error may be wrapped, so the cause chain is walked.
function missingLinuxLibrary(err) {
  let depth = 0;

  for (let current = err; current && depth < 16; current = current.cause, depth++) {
    const found = /([^\s:]+): cannot open shared object file: No such file or directory/.exec(String(current.message));

    if (found && LINUX_SYSTEM_LIBRARIES[found[1]]) {
      return { name: found[1], ...LINUX_SYSTEM_LIBRARIES[found[1]] };
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

  const library = process.platform === 'linux' ? missingLinuxLibrary(err) : null;

  if (library) {
    printError('A native module could not load because a library it needs is missing.');
    print(`voxagent needs ${library.description}, ${library.name}, on Linux.`);
    print(`On Debian and Ubuntu, install it with: sudo apt install ${library.pkg}`);
    process.exit(1);
  }

  printError(err.message);
  process.exit(1);
}

// decibri and the whisper addon are loaded here rather than at the top of the file, so
// that --help, --version and every argument error work on a machine where neither
// native module can load.
let capture = null;

function loadCapture() {
  if (capture) {
    return capture;
  }

  try {
    capture = require('../lib/capture');
    return capture;
  } catch (err) {
    reportNativeLoadFailure(err);
  }
}

// Transcription runs in a child process, because whisper writes its diagnostics from
// native code straight to the process file descriptors and nothing inside this process
// can hide them. The child reports a whisper addon it cannot load rather than crashing
// without an explanation.
async function startWhisper(debug) {
  checkWhisperPlatform(process.platform, process.arch);

  const whisper = require('../lib/whisper').start({ debug });

  try {
    await whisper.ready();
  } catch (err) {
    whisper.stop();
    reportNativeLoadFailure(err);
  }

  return whisper;
}

// Cleanup

let whisperHost = null;
let cleanedUp = false;

// Releases the microphone, stops the transcription child and returns the terminal to
// its normal mode. Every exit path runs this, so the device is never left open.
function cleanup() {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;

  try {
    if (capture) {
      capture.releaseMicrophone();
    }
  } catch (err) {
    // Nothing further can be done about a device that will not close here.
  }

  try {
    if (whisperHost) {
      whisperHost.stop();
    }
  } catch (err) {
    // Nothing further can be done about a child that will not stop here.
  }

  restoreTerminal();
}

function registerCleanup() {
  process.on('exit', cleanup);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }

  process.on('uncaughtException', (err) => {
    cleanup();
    printError(err.message);
    process.exit(1);
  });
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

// Startup
//
// Everything from the Ollama check onward, shared by the interactive loop and --file.
// The language model is confirmed installed and then loaded, and the whisper model is
// checked and then loaded in the transcription child. Returns the whisper model path,
// and exits 1 on any failure.
async function prepareModels(model, debug) {
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

  whisperHost = await startWhisper(debug);

  // Loading here pays the model read and the backend initialisation before the first
  // prompt, so the first transcription costs no more than any later one.
  printStatus('Loading whisper model...');
  try {
    await whisperHost.loadModel(modelPath);
  } catch (err) {
    printError(`Failed to load whisper model: ${err.message}`);
    process.exit(1);
  }
  printStatus('Whisper model ready.');

  return modelPath;
}

// --file

// Answers the question recorded in an audio file, then exits: 0 once the answer is
// printed, and 1 when the file cannot be read, holds no speech or cannot be answered.
// The file is read before any model is checked or loaded, so a file that cannot be used
// fails at once.
async function answerFile(file, model, denoise, debug) {
  const reader = loadCapture();
  let result;

  try {
    result = await reader.readFile(file, { denoise });
  } catch (err) {
    printError(reader.fileErrorMessage(file, err));
    process.exit(1);
  }

  const durationSec = (result.audio.length / 2 / reader.SAMPLE_RATE).toFixed(1);
  printStatus(`Read ${durationSec}s of audio (${result.audio.length} bytes) from ${file}`);

  // A file in which the detector heard no speech is never transcribed, exactly as a
  // recording is not.
  if (!result.speechDetected) {
    print('No speech detected.');
    process.exit(1);
  }

  const modelPath = await prepareModels(model, debug);

  try {
    printStatus('Transcribing...');
    const text = await whisperHost.transcribe(result.audio, modelPath, debug);

    if (!text || !text.trim()) {
      print('No speech detected.');
      process.exit(1);
    }

    printTranscript(text);

    printStatus('\nThinking...');
    const response = await ask(text, model);
    printResponse(response);
  } catch (err) {
    printError(err.message);
    process.exit(1);
  }

  process.exit(0);
}

// Main

async function main() {
  const { model, device, file, listDevices, denoise, debug } = parseCommandLine(process.argv);

  if (listDevices) {
    printDevices();
    return;
  }

  // An audio file needs no key presses, so --file runs whether or not input comes
  // from a terminal.
  if (file !== undefined) {
    registerCleanup();
    printBanner(VERSION);
    await answerFile(file, model, denoise, debug);
    return;
  }

  // voxagent is driven by single key presses, which needs a terminal. With input
  // redirected or piped there is no press to wait for, so this stops here rather than
  // running the whole startup and then ending without saying why.
  if (!process.stdin.isTTY) {
    printError('voxagent needs an interactive terminal.');
    print('Run it in a terminal rather than with input redirected or piped.');
    process.exit(1);
  }

  registerCleanup();

  printBanner(VERSION);

  // The device is resolved first, so that a selector naming no device, or more than one,
  // fails before any model is checked or loaded.
  let selectedDevice;
  if (device !== undefined) {
    selectedDevice = resolveRequestedDevice(device);
    printStatus(`Recording from ${selectedDevice.name}.`);
  }

  const modelPath = await prepareModels(model, debug);

  const recorder = loadCapture();

  print('');

  // Main loop
  while (true) {
    print('Press ENTER to speak, or Ctrl+C to quit.');
    await waitForKey().promise;

    let result;

    try {
      result = await recorder.record({
        device: selectedDevice,
        denoise,
        stopKey: waitForKey(),
        onLive: () => print('Recording. It stops when you stop speaking, or press ENTER to stop now.'),
      });
    } catch (err) {
      printError(recorder.deviceErrorMessage(err));
      process.exit(1);
    }

    // A device that fails during a recording ends that recording and nothing more,
    // so the next turn can start as soon as the device is back.
    if (result.ending === recorder.ENDING.DEVICE_ERROR) {
      printError(recorder.deviceErrorMessage(result.error));
      print('');
      continue;
    }

    const durationSec = (result.audio.length / 2 / recorder.SAMPLE_RATE).toFixed(1);
    printStatus(`Captured ${durationSec}s of audio (${result.audio.length} bytes)`);

    // A recording the detector heard no speech in is never transcribed, so a silent
    // recording cannot reach the language model as a question.
    if (!result.speechDetected) {
      print('No speech detected.\n');
      continue;
    }

    if (result.audio.length < 32000) {
      print('Recording too short. Try again.\n');
      continue;
    }

    if (result.ending === recorder.ENDING.TOO_LONG) {
      printStatus(`Reached the maximum recording length of ${recorder.MAX_RECORDING_MS / 1000} seconds.`);
    }

    try {
      printStatus('Transcribing...');
      const text = await whisperHost.transcribe(result.audio, modelPath, debug);

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
    cleanup();
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
  missingLinuxLibrary,
  reportNativeLoadFailure,
  loadCapture,
  cleanup,
  registerCleanup,
};
