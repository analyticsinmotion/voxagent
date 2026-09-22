'use strict';

const { Microphone } = require('decibri');

// whisper reads 16 kHz mono signed 16-bit audio, so the capture requests exactly
// that. The engine opens the device at its native rate and resamples to the
// requested rate, so 16 kHz arrives whatever the device reports. Every
// conditioning stage is off unless its option is passed, which leaves the signal
// whisper receives unprocessed.
function startCapture() {
  const mic = new Microphone({ sampleRate: 16000, channels: 1, dtype: 'int16' });
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

module.exports = { startCapture, stopCapture };
