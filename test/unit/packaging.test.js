'use strict';

// Checks what is published and what is run: npm pack lists exactly the files the
// package ships and nothing under test/, and each test script names exactly the
// test files in its directory, so a new test file cannot be left out of a run.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { REPO } = require('../helpers/repo');

const PUBLISHED = [
  'ATTRIBUTION.md',
  'LICENSE',
  'README.md',
  'bin/voxagent.js',
  'lib/capture.js',
  'lib/llm.js',
  'lib/model.js',
  'lib/stt.js',
  'lib/ui.js',
  'lib/whisper.js',
  'package.json',
];

describe('the published package', () => {
  it('lists exactly the files voxagent ships, and nothing under test/', { timeout: 120000 }, () => {
    const run = spawnSync('npm pack --dry-run --json', { cwd: REPO, shell: true, encoding: 'utf8' });

    assert.strictEqual(run.status, 0, run.stderr);

    const [pack] = JSON.parse(run.stdout);
    const files = pack.files.map((file) => file.path.replace(/\\/g, '/')).sort();

    assert.deepStrictEqual(files, PUBLISHED);
    assert.ok(!files.some((file) => file.startsWith('test/')));
  });
});

describe('the test scripts', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;

  const testFiles = (dir) => fs.readdirSync(path.join(REPO, 'test', dir))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `test/${dir}/${name}`)
    .sort();

  const named = (script) => {
    assert.strictEqual(typeof script, 'string', 'the script is defined');
    const words = script.split(/\s+/);
    assert.deepStrictEqual(words.slice(0, 2), ['node', '--test']);
    return words.slice(2).sort();
  };

  it('npm test runs every file in test/unit and nothing else', () => {
    assert.deepStrictEqual(named(scripts.test), testFiles('unit'));
  });

  it('npm run test:integration runs every file in test/integration and nothing else', () => {
    assert.deepStrictEqual(named(scripts['test:integration']), testFiles('integration'));
  });
});
