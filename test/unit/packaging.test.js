'use strict';

// Checks what is published and what is run: npm pack lists exactly the files the
// package ships and nothing under test/, each test script names exactly the test files
// in its directory, so a new test file cannot be left out of a run, and the release
// check refuses a tag that does not name the package version or whose commit is not on
// main.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { REPO } = require('../helpers/repo');
const { runNode, describeRun } = require('../helpers/run');

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

describe('the release check', { timeout: 120000 }, () => {
  const SCRIPT = path.join(REPO, '.github', 'scripts', 'verify-release.js');

  let dir;
  let upstream;
  let clone;
  let env;
  const commits = {};

  // git runs with an empty global configuration and no system configuration, so no
  // setting on the machine, such as commit signing or line ending conversion, changes
  // what the scratch repositories hold.
  const git = (cwd, ...args) => {
    const run = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.strictEqual(run.status, 0, `git ${args.join(' ')}\n${run.stdout}${run.stderr}`);
    return run.stdout.trim();
  };

  const commitVersion = (version, message) => {
    fs.writeFileSync(path.join(upstream, 'package.json'), `${JSON.stringify({ name: 'release-check', version }, null, 2)}\n`);
    git(upstream, 'add', 'package.json');
    git(upstream, 'commit', '--quiet', '-m', message);
    return git(upstream, 'rev-parse', 'HEAD');
  };

  const tag = (name) => git(upstream, 'tag', '-a', name, '-m', name);

  // The clone has origin/main and every tag, as a checkout with full history does.
  //
  //   main   one (1.0.0, tagged v1.0.0 and v1.0.1) -- three (1.1.0)
  //   side     \-- two (2.0.0, tagged v2.0.0)
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-release-'));
    upstream = path.join(dir, 'upstream');
    clone = path.join(dir, 'clone');

    const config = path.join(dir, 'gitconfig');
    fs.writeFileSync(config, '');
    env = {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Release check',
      GIT_AUTHOR_EMAIL: 'release-check@example.invalid',
      GIT_COMMITTER_NAME: 'Release check',
      GIT_COMMITTER_EMAIL: 'release-check@example.invalid',
    };

    fs.mkdirSync(upstream);
    git(upstream, 'init', '--quiet', '--initial-branch=main');

    commits.one = commitVersion('1.0.0', 'one');
    tag('v1.0.0');
    tag('v1.0.1');

    git(upstream, 'checkout', '--quiet', '-b', 'side');
    commits.two = commitVersion('2.0.0', 'two');
    tag('v2.0.0');

    git(upstream, 'checkout', '--quiet', 'main');
    commits.three = commitVersion('1.1.0', 'three');

    git(dir, 'clone', '--quiet', upstream, clone);
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const check = (args, repository) => runNode([SCRIPT, ...args, repository || clone], { env, cwd: REPO });

  it('accepts a tag that names the package version and points at a commit on main', async () => {
    const run = await check(['v1.0.0', commits.one]);

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.deepStrictEqual(run.lines, [`The tag v1.0.0 names version 1.0.0 from package.json and points at ${commits.one}, which is on main.`]);
  });

  it('refuses a tag that does not match the version in package.json', async () => {
    const run = await check(['v1.0.1', commits.one]);

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, ['Error: The tag v1.0.1 does not match the version in package.json, which is 1.0.0. A release tag is v followed by that version.']);
  });

  it('refuses a tag whose commit is not on main, although it names the package version', async () => {
    const run = await check(['v2.0.0', commits.two]);

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [`Error: The commit ${commits.two} is not on main.`]);
  });

  it('refuses a commit the tag does not point at', async () => {
    const run = await check(['v1.0.0', commits.three]);

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [`Error: The tag v1.0.0 points at ${commits.one}, not at ${commits.three}.`]);
  });

  it('refuses when the repository has no origin/main to check against', async () => {
    const run = await check(['v1.0.0', commits.one], upstream);

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, ['Error: origin/main is not in the repository. Check out with full history.']);
  });

  it('exits 2 with the usage when the commit is not a full SHA or an argument is missing', async () => {
    for (const args of [['v1.0.0', commits.one.slice(0, 12)], ['v1.0.0']]) {
      const run = await runNode([SCRIPT, ...args], { env, cwd: clone });

      assert.strictEqual(run.status, 2, describeRun(run));
      assert.deepStrictEqual(run.lines, ['Usage: node verify-release.js <tag> <commit> [<repository directory>]']);
    }
  });
});
