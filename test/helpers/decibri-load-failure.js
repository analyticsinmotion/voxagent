'use strict';

// Loaded with --require. process.platform and process.arch report linux and x64, and
// every require of decibri throws the error decibri's loader throws there when the
// dynamic loader cannot find the library VOXAGENT_TEST_MISSING_LIBRARY names.

const Module = require('module');

const { decibriLoadError } = require('./fakes');

const missing = process.env.VOXAGENT_TEST_MISSING_LIBRARY;

// The standard streams are created before process.platform changes, because Node
// creates each on first use and chooses from the platform whether a pipe is written
// synchronously, and output written asynchronously is lost when the process exits.
process.stdout;
process.stderr;
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });

const load = Module._load;

Module._load = function loadWithoutDecibri(request, ...rest) {
  if (request === 'decibri') {
    throw decibriLoadError(missing);
  }

  return load.call(this, request, ...rest);
};
