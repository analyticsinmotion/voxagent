'use strict';

const { Microphone, inputDevices } = require('decibri');

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

// whisper reads 16 kHz mono signed 16-bit audio, so the capture requests exactly
// that. The engine opens the device at its native rate and resamples to the
// requested rate, so 16 kHz arrives whatever the device reports. Every
// conditioning stage is off unless its option is passed, which leaves the signal
// whisper receives unprocessed. With no device given the engine uses the system default.
function startCapture(device) {
  const options = { sampleRate: 16000, channels: 1, dtype: 'int16' };

  if (device) {
    options.device = { id: device.id };
  }

  const mic = new Microphone(options);
  const chunks = [];

  mic.on('data', (chunk) => {
    chunks.push(chunk);
  });

  mic.on('error', (err) => {
    console.error('Mic error:', err.message);
  });

  return { mic, chunks };
}

function stopCapture(handle) {
  handle.mic.stop();
  return Buffer.concat(handle.chunks);
}

module.exports = { startCapture, stopCapture, listDevices, resolveDevice };
