'use strict';

const { Microphone, inputDevices } = require('decibri');

// whisper reads 16 kHz mono signed 16-bit audio, so the capture requests exactly
// that. The engine opens the device at its native rate and resamples to the
// requested rate, so 16 kHz arrives whatever the device reports.
const SAMPLE_RATE = 16000;

// The pause that ends a recording. It is the length of sub-threshold audio the
// detector requires before it reports silence. The gaps inside a spoken question
// were measured on real speech, and the longest gap inside a fluent sentence was
// 200 ms while a deliberate pause reached several seconds. This value is the
// upper end of the range the measurements allow.
const END_OF_SPEECH_MS = 1500;

// A recording in which the detector never reports speech ends here.
const NO_SPEECH_MS = 8000;

// A recording ends here whatever else happens, so continuous noise cannot grow
// one without bound.
const MAX_RECORDING_MS = 60000;

// The engine flushes the audio buffered at the moment of the stop and then ends
// the stream, so the last chunk arrives after stop() returns. This is how long to
// wait for that end, in case it never comes.
const END_WAIT_MS = 1000;

// How a recording finished. The caller decides what each one means for the turn.
const ENDING = {
  SPEECH_ENDED: 'speech-ended',
  STOPPED: 'stopped',
  NO_SPEECH: 'no-speech',
  TOO_LONG: 'too-long',
  DEVICE_ERROR: 'device-error',
};

// Every input the audio engine reports, each with a stable per-host id, its channel count
// and its native rate.
function listDevices() {
  return inputDevices();
}

// Resolves a selector against a device list. An exact match on the stable id wins
// outright, because an id names one device and nothing else. Otherwise every device whose
// name contains the selector, ignoring case, is returned, so a caller can report a
// selector that names more than one device rather than picking one of them.
function resolveDevice(selector, devices) {
  const list = devices || listDevices();
  const byId = list.find((device) => device.id === selector);

  if (byId) {
    return [byId];
  }

  const needle = String(selector).toLowerCase();

  return list.filter((device) => String(device.name).toLowerCase().includes(needle));
}

// The audio engine reports a failure as a stable code on the error. These turn the
// codes a user can actually hit into a message that says what to do about it.
function deviceErrorMessage(err) {
  const code = err && err.code;

  if (code === 'MICROPHONE_NOT_FOUND' || code === 'NO_MICROPHONE_FOUND') {
    return 'No microphone was found. Connect one, then run voxagent --list-devices to check it is seen.';
  }

  if (code === 'PERMISSION_DENIED') {
    return 'Microphone access is blocked. Allow microphone access for your terminal in the system privacy settings.';
  }

  if (code === 'DEVICE_FAILED') {
    return 'The microphone stopped responding. Check it is still connected, then press ENTER to try again.';
  }

  if (code === 'NOT_AN_INPUT_DEVICE') {
    return 'The selected device is not an input. Run voxagent --list-devices to see the inputs.';
  }

  if (code === 'MULTIPLE_DEVICES_MATCH') {
    return 'More than one input matched. Pass an id to --device, which you can read from voxagent --list-devices.';
  }

  if (code === 'DEVICE_ENUMERATION_FAILED') {
    return 'The audio devices could not be listed. Check the system sound settings.';
  }

  return (err && err.message) || String(err);
}

function microphoneOptions(settings) {
  const options = {
    sampleRate: SAMPLE_RATE,
    channels: 1,
    dtype: 'int16',
    vad: { model: 'silero', holdoffMs: settings.endOfSpeechMs },
  };

  if (settings.device) {
    options.device = { id: settings.device.id };
  }

  if (settings.denoise) {
    options.denoise = 'fastenhancer-t';
  }

  return options;
}

// A capture failure destroys the stream, so no end event follows one. Waiting for
// any of the three endings, with a timeout, is what keeps this bounded.
function waitForEnd(mic, timeoutMs) {
  if (mic.destroyed || mic.readableEnded) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);

    mic.once('end', finish);
    mic.once('close', finish);
    mic.once('error', finish);
  });
}

// The microphone currently open, if any. One recording runs at a time, so this
// holds at most one. It is what lets an exit path release the device without
// having to reach inside the recording that opened it.
let openMicrophone = null;

// Stops the microphone if one is open. Safe to call at any point and more than
// once, which is what an exit path needs.
function releaseMicrophone() {
  const mic = openMicrophone;

  openMicrophone = null;

  if (!mic) {
    return false;
  }

  try {
    mic.stop();
  } catch (err) {
    // The device is already closed, which is the state this asks for.
  }

  return true;
}

// Opens the microphone, records until one of the five endings, and returns the
// audio along with whether any speech was detected and how the recording ended.
// The microphone is opened for the recording and closed at the end of it, so it is
// never open while voxagent waits at the prompt.
async function record(options) {
  const settings = {
    endOfSpeechMs: END_OF_SPEECH_MS,
    noSpeechMs: NO_SPEECH_MS,
    maxRecordingMs: MAX_RECORDING_MS,
    endWaitMs: END_WAIT_MS,
    engine: Microphone,
    ...options,
  };

  const mic = await settings.engine.open(microphoneOptions(settings));

  openMicrophone = mic;

  const chunks = [];
  let speechDetected = false;
  let live = false;
  let ending = null;
  let deviceError = null;
  let finish;

  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const end = (reason) => {
    if (ending) {
      return;
    }
    ending = reason;
    finish();
  };

  const noSpeechTimer = setTimeout(() => end(ENDING.NO_SPEECH), settings.noSpeechMs);
  const maxTimer = setTimeout(() => end(ENDING.TOO_LONG), settings.maxRecordingMs);

  mic.on('data', (chunk) => {
    chunks.push(chunk);

    // The recording line is printed from here rather than before the open, so the
    // user is never invited to speak before audio is being captured.
    if (!live) {
      live = true;
      if (settings.onLive) {
        settings.onLive();
      }
    }
  });

  mic.on('speech', () => {
    speechDetected = true;
    clearTimeout(noSpeechTimer);
  });

  mic.on('silence', () => {
    if (speechDetected) {
      end(ENDING.SPEECH_ENDED);
    }
  });

  mic.on('error', (err) => {
    deviceError = err;
    end(ENDING.DEVICE_ERROR);
  });

  if (settings.stopKey) {
    settings.stopKey.promise.then((reason) => {
      if (reason === 'key') {
        end(ENDING.STOPPED);
      }
    });
  }

  await done;

  clearTimeout(noSpeechTimer);
  clearTimeout(maxTimer);

  // The key listener is removed here rather than left behind, so the next press of
  // ENTER is not swallowed by a listener from a recording that has already ended.
  if (settings.stopKey) {
    settings.stopKey.cancel();
  }

  openMicrophone = null;
  mic.stop();

  // The engine delivers the audio it had buffered after the stop and only then
  // ends the stream, so the concatenation waits for that end rather than running
  // on the line after the stop and dropping the last of the recording.
  await waitForEnd(mic, settings.endWaitMs);

  return {
    audio: Buffer.concat(chunks),
    speechDetected,
    ending,
    error: deviceError,
  };
}

module.exports = {
  record,
  releaseMicrophone,
  listDevices,
  resolveDevice,
  deviceErrorMessage,
  ENDING,
  END_OF_SPEECH_MS,
  NO_SPEECH_MS,
  MAX_RECORDING_MS,
  SAMPLE_RATE,
};
