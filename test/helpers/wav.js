'use strict';

// Reads the sample data out of a WAV file and builds WAV files. The reader walks
// the RIFF chunks rather than assuming a 44-byte header, because the fixture's
// format chunk is 18 bytes long and its samples start at byte 46.

const fs = require('fs');

function readWavPayload(file) {
  const buffer = fs.readFileSync(file);

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF WAVE file`);
  }

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === 'data') {
      return buffer.subarray(offset + 8, offset + 8 + size);
    }

    offset += 8 + size + (size % 2);
  }

  throw new Error(`${file} has no data chunk`);
}

// A 16-bit PCM WAV file holding the given samples.
function wavFile(pcm, sampleRate, channels) {
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

module.exports = { readWavPayload, wavFile };
