#!/usr/bin/env node
'use strict';

const { waitForKey, print, printError, printTranscript, printResponse, printStatus, printBanner } = require('../lib/ui');
const { startCapture, stopCapture } = require('../lib/capture');
const { ensureModel } = require('../lib/model');
const { transcribe, loadModel } = require('../lib/stt');
const { checkConnection, ask, DEFAULT_MODEL } = require('../lib/llm');

const VERSION = '0.1.0';

const USAGE = `
Usage: voxagent [options]

Voice-powered terminal agent. Fully offline.

Options:
  --model <name>   Ollama model to use (default: ${DEFAULT_MODEL})
  --debug          Save each recording to debug-capture.wav in the current directory
  --help, -h       Show this help message
  --version, -v    Show version number
`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE.trim());
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    process.exit(0);
  }

  const modelIdx = args.indexOf('--model');
  const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : DEFAULT_MODEL;
  const debug = args.includes('--debug');

  return { model, debug };
}

async function main() {
  const { model, debug } = parseArgs(process.argv);

  printBanner(VERSION);

  // Preflight: check Ollama
  printStatus('Checking Ollama connection...');
  if (!(await checkConnection())) {
    printError('Ollama is not running. Start it with: ollama serve');
    printError('Install Ollama from https://ollama.com');
    process.exit(1);
  }
  printStatus(`Ollama connected. Model: ${model}`);

  // Preflight: ensure whisper model
  printStatus('Checking whisper model...');
  let modelPath;
  try {
    modelPath = await ensureModel();
  } catch (err) {
    printError(`Failed to set up whisper model: ${err.message}`);
    process.exit(1);
  }

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

  print('');

  // Main loop
  while (true) {
    print('Press ENTER to speak...');
    await waitForKey();

    print('[Recording...] Press ENTER to stop.');
    const handle = startCapture();
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

main().catch((err) => {
  printError(err.message);
  process.exit(1);
});
