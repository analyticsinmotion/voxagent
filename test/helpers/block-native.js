'use strict';

// Loaded with --require. Every attempt to load a native module throws, and each
// attempt is appended to the file VOXAGENT_TEST_NATIVE_LOG names. A run that
// records no attempt loaded no native module.

const fs = require('fs');

const log = process.env.VOXAGENT_TEST_NATIVE_LOG;

process.dlopen = function blockedDlopen(module, filename) {
  if (log) {
    fs.appendFileSync(log, `${filename}\n`);
  }

  const err = new Error(`native modules cannot be loaded in this test: ${filename}`);
  err.code = 'ERR_DLOPEN_FAILED';
  throw err;
};
