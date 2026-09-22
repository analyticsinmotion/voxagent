'use strict';

const fs = require('fs');
const path = require('path');
const { transcribe: whisperTranscribe } = require('@kutalia/whisper-node-addon');

const SAMPLE_RATE = 16000;

function createWavBuffer(pcmInt16Buffer) {
  const dataSize = pcmInt16Buffer.length;
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write('RIFF', 0);                    // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);      // ChunkSize
  header.write('WAVE', 8);                     // Format

  // fmt sub-chunk
  header.write('fmt ', 12);                    // Subchunk1ID
  header.writeUInt32LE(16, 16);                // Subchunk1Size (PCM = 16)
  header.writeUInt16LE(1, 20);                 // AudioFormat (PCM = 1)
  header.writeUInt16LE(1, 22);                 // NumChannels (mono = 1)
  header.writeUInt32LE(16000, 24);             // SampleRate
  header.writeUInt32LE(32000, 28);             // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  header.writeUInt16LE(2, 32);                 // BlockAlign (NumChannels * BitsPerSample/8)
  header.writeUInt16LE(16, 34);                // BitsPerSample

  // data sub-chunk
  header.write('data', 36);                    // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);          // Subchunk2Size

  return Buffer.concat([header, pcmInt16Buffer]);
}

// whisper reads pcmf32 as mono 32-bit float samples at 16 kHz in the range -1 to 1.
// Dividing each signed 16-bit sample by 32768 maps -32768 to exactly -1 and 32767 to
// just under 1. readInt16LE is used rather than an Int16Array view so the conversion
// does not depend on the byte offset of the incoming buffer being even.
function toFloat32Samples(pcmInt16Buffer) {
  const sampleCount = Math.floor(pcmInt16Buffer.length / 2);
  const samples = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    samples[i] = pcmInt16Buffer.readInt16LE(i * 2) / 32768;
  }

  return samples;
}

// Built in one place so that the warm-up call and a real call reach the addon with
// identical options, which is what lets the addon reuse the model it already loaded.
// The addon merges translate: true into every call it is not given, which against a
// multilingual model would translate rather than transcribe, so it is set here.
function whisperOptions(samples, modelPath) {
  return {
    pcmf32: samples,
    model: modelPath,
    language: 'en',
    use_gpu: true,
    no_prints: true,
    translate: false,
  };
}

// The addon returns { transcription: string[][] | string[] }. Each segment is
// ["00:00:00.000", "00:00:06.800", " actual text here"], so the first two elements are
// timestamps and the rest is text.
function extractText(result) {
  if (result && result.transcription) {
    return result.transcription
      .map((segment) => {
        if (Array.isArray(segment)) {
          return segment
            .filter((s) => !s.match(/^\d{2}:\d{2}:\d{2}\.\d{3}$/))
            .join(' ');
        }
        return String(segment);
      })
      .join(' ')
      .trim();
  }

  return '';
}

// Loads the whisper model by transcribing one second of silence with the same model
// path and options a real call uses. The addon keeps the model loaded afterwards, so
// later calls skip the model read and the backend initialisation. The text is discarded.
async function loadModel(modelPath) {
  const silence = new Float32Array(SAMPLE_RATE);
  await whisperTranscribe(whisperOptions(silence, modelPath));
}

// An empty sample array makes the addon return a segment with negative timestamps
// and a run of punctuation rather than failing, so a recording with no samples is
// refused before the addon is reached.
function requireSamples(samples) {
  if (!samples || samples.length === 0) {
    throw new Error('There is no audio to transcribe.');
  }

  return samples;
}

async function transcribe(pcmInt16Buffer, modelPath, debug) {
  if (debug) {
    const debugPath = path.join(process.cwd(), 'debug-capture.wav');
    const wavBuffer = createWavBuffer(pcmInt16Buffer);
    fs.writeFileSync(debugPath, wavBuffer);
    console.log(`[debug] Saved recording to ${debugPath} (${wavBuffer.length} bytes)`);

    // Check audio levels. readInt16LE is used rather than an Int16Array view so the
    // reading does not depend on the byte offset of the incoming buffer being even.
    const sampleCount = Math.floor(pcmInt16Buffer.length / 2);
    let max = 0, sum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const abs = Math.abs(pcmInt16Buffer.readInt16LE(i * 2));
      if (abs > max) max = abs;
      sum += abs;
    }
    console.log(`[debug] Audio: ${sampleCount} samples, max=${max}, avg=${(sum / sampleCount).toFixed(1)}, silence=${max < 100}`);
  }

  const result = await whisperTranscribe(whisperOptions(requireSamples(toFloat32Samples(pcmInt16Buffer)), modelPath));

  if (debug) {
    console.log('[debug] Whisper result:', JSON.stringify(result));
  }

  return extractText(result);
}

module.exports = { transcribe, loadModel, createWavBuffer, toFloat32Samples, requireSamples };
