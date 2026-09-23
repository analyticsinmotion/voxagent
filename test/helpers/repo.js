'use strict';

// Paths the tests use, all derived from this file's location, so the suite runs
// against whichever copy of the repository it sits in.

const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

module.exports = {
  REPO,
  BIN: path.join(REPO, 'bin', 'voxagent.js'),
  FIXTURE: path.join(REPO, 'test', 'fixtures', 'what-is-the-capital-of-australia.wav'),
  FIXTURE_TEXT: 'What is the capital of Australia?',
  HELPERS: __dirname,
  lib: (name) => path.join(REPO, 'lib', `${name}.js`),
  helper: (name) => path.join(__dirname, `${name}.js`),
};
