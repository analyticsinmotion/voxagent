'use strict';

// Places stand-in exports in the module cache, so that a later require returns
// them without loading the real file. The unit tests use this for decibri, the
// whisper addon's native binary and Ollama, so they load no native code and reach
// no server.

const Module = require('module');
const os = require('os');
const path = require('path');

const { REPO } = require('./repo');

const LIB = path.join(REPO, 'lib');
const WHISPER_PACKAGE = '@kutalia/whisper-node-addon';

// The file a require of request from the lib directory loads. A package name is
// resolved through node_modules and an absolute path is resolved as it stands,
// both through the same resolution require itself uses.
function resolveFrom(request, from) {
  return require.resolve(request, { paths: [from || LIB] });
}

function stubModule(request, exports, from) {
  const filename = resolveFrom(request, from);
  const stub = new Module(filename);

  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;

  return filename;
}

function forget(request, from) {
  delete require.cache[resolveFrom(request, from)];
}

function whisperDist() {
  return path.join(path.dirname(resolveFrom(WHISPER_PACKAGE)), '..');
}

// The whisper binary lib/stt.js loads on a platform: the addon's own
// dist/<platform>-<arch>/whisper.node, or dist/mac-arm64/whisper.node on macOS on
// Apple Silicon, where lib/stt.js loads it itself.
function whisperBinaryPath(platform, arch) {
  const dir = platform === 'darwin' && arch === 'arm64' ? 'mac-arm64' : `${platform}-${arch}`;
  return path.join(whisperDist(), dir, 'whisper.node');
}

// Puts a native whisper function in place of the binary lib/stt.js loads on this
// machine, and clears lib/stt.js and the addon's wrapper from the cache so that the
// next require of either goes through the stand-in.
function stubWhisperNative(whisper) {
  stubModule(whisperBinaryPath(process.platform, process.arch), { whisper });
  forget(WHISPER_PACKAGE);
  forget(path.join(LIB, 'stt.js'));
}

// Loads the addon's own wrapper, dist/js/index.js, over a native whisper function.
// The wrapper picks its binary from os.platform() and os.arch() as it loads, so
// those two report win32 and x64 while it loads, which is a binary the package
// ships on every platform. That lets the wrapper run on any machine.
function loadAddonWrapper(whisper) {
  const binary = resolveFrom(path.join(whisperDist(), 'win32-x64', 'whisper.node'));
  const wrapper = resolveFrom(WHISPER_PACKAGE);
  const saved = { binary: require.cache[binary], wrapper: require.cache[wrapper] };
  const realPlatform = os.platform;
  const realArch = os.arch;

  stubModule(binary, { whisper });
  delete require.cache[wrapper];
  os.platform = () => 'win32';
  os.arch = () => 'x64';

  try {
    return require(wrapper);
  } finally {
    os.platform = realPlatform;
    os.arch = realArch;

    // Whatever the cache held for these two files before is put back, so a stand-in
    // another part of the test installed is left as it was.
    for (const [key, file] of [['binary', binary], ['wrapper', wrapper]]) {
      if (saved[key]) {
        require.cache[file] = saved[key];
      } else {
        delete require.cache[file];
      }
    }
  }
}

module.exports = {
  LIB,
  WHISPER_PACKAGE,
  resolveFrom,
  stubModule,
  forget,
  whisperDist,
  whisperBinaryPath,
  stubWhisperNative,
  loadAddonWrapper,
};
