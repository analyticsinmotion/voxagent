'use strict';

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const WHISPER_PACKAGE = '@kutalia/whisper-node-addon';

const SAMPLE_RATE = 16000;

// The defaults the addon's own wrapper merges under the caller's options, in the
// order it merges them (dist/js/index.js).
const ADDON_DEFAULTS = {
  language: 'en',
  use_gpu: true,
  flash_attn: false,
  no_prints: true,
  comma_in_time: false,
  translate: true,
  no_timestamps: false,
  detect_language: false,
  audio_ctx: 0,
  max_len: 0,
};

// Does what the addon's wrapper does once it holds the native function: merges the
// same defaults in the same order, makes the same two checks, and turns the native
// callback into a promise with util.promisify.
function wrapNative(whisper) {
  const whisperAsync = promisify(whisper);

  return async function transcribe(options) {
    const params = Object.assign({}, ADDON_DEFAULTS, options);

    if (!params.model) {
      throw new Error('Model path is required');
    }

    if (!params.fname_inp && !params.pcmf32) {
      throw new Error('Input file path is required');
    }

    return whisperAsync(params);
  };
}

// The addon's wrapper loads dist/<platform>-<arch>/whisper.node, but the addon ships
// its macOS binaries under dist/mac-<arch>, a name that wrapper never computes. On
// macOS on Apple Silicon the binary is therefore loaded here and wrapped by
// wrapNative. Every other platform requires the addon itself. A load failure is
// reported in the same words the addon's wrapper uses.
function loadWhisper(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') {
    const binary = path.join(path.dirname(require.resolve(WHISPER_PACKAGE)), '..', 'mac-arm64', 'whisper.node');
    let native;

    try {
      native = require(binary);
    } catch (error) {
      throw new Error(`Failed to load native addon: ${error}`);
    }

    return wrapNative(native.whisper);
  }

  return require(WHISPER_PACKAGE).transcribe;
}

const whisperTranscribe = loadWhisper(process.platform, process.arch);

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
// Every option in the addon's defaults is set here rather than inherited, so the
// native function receives the same options whichever loader supplied it. translate
// is false, because the addon's default of true would translate rather than
// transcribe against a multilingual model. comma_in_time is false, because
// extractText recognises a timestamp by its full stop.
function whisperOptions(samples, modelPath) {
  return {
    pcmf32: samples,
    model: modelPath,
    language: 'en',
    use_gpu: true,
    flash_attn: false,
    no_prints: true,
    comma_in_time: false,
    translate: false,
    no_timestamps: false,
    detect_language: false,
    audio_ctx: 0,
    max_len: 0,
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

module.exports = {
  transcribe,
  loadModel,
  loadWhisper,
  createWavBuffer,
  toFloat32Samples,
  requireSamples,
  whisperOptions,
};
