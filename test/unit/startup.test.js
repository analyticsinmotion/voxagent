'use strict';

// Checks what voxagent confirms before it starts: the Ollama model match, the one
// Ollama client, the platforms the whisper addon can load on, the missing Visual
// C++ runtime check, the missing Linux system library check for decibri and the
// whisper addon, and the supported Node range and dependency versions.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { BIN, REPO, lib, helper } = require('../helpers/repo');
const { runNode, describeRun } = require('../helpers/run');
const { decibriLoadError } = require('../helpers/fakes');
const { stubModule, forget, resolveFrom, whisperDist } = require('../helpers/modules');
const { listen, close, ollamaServer } = require('../helpers/servers');
const { satisfies } = require('../helpers/versions');

const cli = require(BIN);

describe('the Ollama model check', { timeout: 120000 }, () => {
  const llm = require(lib('llm'));

  it('accepts the name and the name with :latest, and rejects a name that only shares a prefix', () => {
    assert.strictEqual(llm.modelMatches('llama3.2', 'llama3.2:latest'), true);
    assert.strictEqual(llm.modelMatches('llama3.2', 'llama3.2'), true);
    assert.strictEqual(llm.modelMatches('llama3.2', 'llama3.2-vision:latest'), false);
    assert.strictEqual(llm.modelMatches('llama3.2', 'llama3.21:latest'), false);
    assert.strictEqual(llm.modelMatches('llama3.2:1b', 'llama3.2:latest'), false);
    assert.strictEqual(llm.modelMatches('llama3.2:1b', 'llama3.2:1b'), true);
  });

  const listings = [
    ['listed as llama3.2:latest', ['llama3.2:latest'], true],
    ['listed as llama3.2', ['llama3.2'], true],
    ['absent', ['qwen3:14b', 'gemma3:1b'], false],
    ['only llama3.2-vision:latest listed', ['llama3.2-vision:latest'], false],
  ];

  for (const [label, names, expected] of listings) {
    it(`finds llama3.2 ${expected ? 'present' : 'absent'} when it is ${label}, against a stub server`, async () => {
      const server = ollamaServer(names);
      const host = await listen(server);

      try {
        assert.strictEqual(await llm.hasModel('llama3.2', host), expected);
      } finally {
        await close(server);
      }
    });
  }

  it('reports no connection when nothing is listening', async () => {
    const server = http.createServer();
    const host = await listen(server);
    await close(server);

    assert.strictEqual(await llm.checkConnection(host), false);
  });
});

describe('the Ollama client', { timeout: 120000 }, () => {
  let constructed = 0;
  let server;
  let host;

  before(async () => {
    const { Ollama } = require(resolveFrom('ollama'));

    class CountingOllama extends Ollama {
      constructor(config) {
        super(config);
        constructed += 1;
      }
    }

    stubModule('ollama', { Ollama: CountingOllama });
    forget(lib('llm'));

    server = ollamaServer(['llama3.2:latest'], 'an answer');
    host = await listen(server);
  });

  after(async () => {
    await close(server);
    forget('ollama');
    forget(lib('llm'));
  });

  it('is constructed once across several calls, against a stub server', async () => {
    const llm = require(lib('llm'));

    assert.strictEqual(await llm.checkConnection(host), true);
    assert.strictEqual(await llm.hasModel('llama3.2', host), true);
    assert.strictEqual(await llm.ask('one', 'llama3.2', host), 'an answer');
    assert.strictEqual(await llm.ask('two', 'llama3.2', host), 'an answer');
    assert.strictEqual(await llm.ask('three', 'llama3.2', host), 'an answer');
    assert.strictEqual(constructed, 1);
  });
});

describe('the platforms the whisper addon can load on', { timeout: 120000 }, () => {
  it('lists darwin-arm64, linux-x64 and win32-x64, and no other pair', () => {
    assert.deepStrictEqual(cli.whisperTargets(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
  });

  it('lists only pairs with a binary where their loader looks, and leaves out darwin-x64 although mac-x64 holds a file', () => {
    const dist = whisperDist();

    for (const target of cli.whisperTargets()) {
      const dir = target === 'darwin-arm64' ? 'mac-arm64' : target;
      assert.ok(fs.existsSync(path.join(dist, dir, 'whisper.node')), `${target} has its binary in ${dir}`);
    }

    assert.ok(fs.existsSync(path.join(dist, 'mac-x64', 'whisper.node')));
    assert.ok(!cli.whisperTargets().includes('darwin-x64'));
  });

  it('exits 1 naming an unsupported pair and listing the supported ones', async () => {
    const script = `require(${JSON.stringify(BIN)}).checkWhisperPlatform('darwin', 'x64'); console.log('returned');`;
    const run = await runNode(['-e', script], { cwd: REPO });

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [
      'Error: voxagent does not support darwin on x64.',
      'Supported platforms: darwin-arm64, linux-x64, win32-x64.',
    ]);
  });

  it('returns for a supported pair', async () => {
    const script = `require(${JSON.stringify(BIN)}).checkWhisperPlatform('darwin', 'arm64'); console.log('returned');`;
    const run = await runNode(['-e', script], { cwd: REPO });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.deepStrictEqual(run.lines, ['returned']);
  });
});

describe('the missing Visual C++ runtime check', { timeout: 120000 }, () => {
  let dir;
  let present;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-dlopen-'));
    present = path.join(dir, 'present.node');
    fs.writeFileSync(present, 'a module file that exists');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The shape Windows gives a native module whose own file exists and one of whose
  // imported libraries does not.
  const dlopenError = (message) => Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });

  it('recognises a module that exists but cannot find a library it imports', () => {
    const err = dlopenError(`The specified module could not be found.\r\n${present}`);
    assert.strictEqual(cli.missingLibraryError(err), err);
  });

  it('finds that error inside a wrapping error, through the cause chain', () => {
    const inner = dlopenError(`The specified module could not be found.\r\n${present}`);
    const outer = new Error('Cannot find native binding.', { cause: inner });
    assert.strictEqual(cli.missingLibraryError(outer), inner);
  });

  it('does not blame the runtime when the module file itself is absent', () => {
    const err = dlopenError(`The specified module could not be found.\r\n${path.join(dir, 'absent.node')}`);
    assert.strictEqual(cli.missingLibraryError(err), null);
  });

  it('does not blame the runtime for another load failure or another error code', () => {
    assert.strictEqual(cli.missingLibraryError(dlopenError(`${present} is not a valid Win32 application.\r\n${present}`)), null);
    assert.strictEqual(cli.missingLibraryError(Object.assign(new Error(`The specified module could not be found.\r\n${present}`), { code: 'MODULE_NOT_FOUND' })), null);
  });
});

describe('the missing Linux system library check', { timeout: 120000 }, () => {
  // What the transcription child reports when the dynamic loader cannot find a
  // library, in the form the loader wrote for libwhisper.so.1 on Linux.
  const loadError = (name) => new Error(`Failed to load native addon: Error: ${name}: cannot open shared object file: No such file or directory`);

  it('names the Vulkan loader and the GNU OpenMP runtime with the package that provides each', () => {
    assert.deepStrictEqual(cli.missingLinuxLibrary(loadError('libvulkan.so.1')), { name: 'libvulkan.so.1', description: 'the Vulkan loader', pkg: 'libvulkan1' });
    assert.deepStrictEqual(cli.missingLinuxLibrary(loadError('libgomp.so.1')), { name: 'libgomp.so.1', description: 'the GNU OpenMP runtime', pkg: 'libgomp1' });
  });

  it('names the ALSA library with its package when decibri cannot load, through the cause chain its loader builds', () => {
    assert.deepStrictEqual(cli.missingLinuxLibrary(decibriLoadError('libasound.so.2')), { name: 'libasound.so.2', description: 'the ALSA library', pkg: 'libasound2t64' });
  });

  it('finds the library inside a wrapping error, through the cause chain', () => {
    const outer = new Error('Cannot load the addon.', { cause: loadError('libvulkan.so.1') });
    assert.strictEqual(cli.missingLinuxLibrary(outer).name, 'libvulkan.so.1');
  });

  it('names no system library when the missing one is shipped with the addon, or the error is of another kind', () => {
    assert.strictEqual(cli.missingLinuxLibrary(loadError('libwhisper.so.1')), null);
    assert.strictEqual(cli.missingLinuxLibrary(loadError('libggml-vulkan.so')), null);
    assert.strictEqual(cli.missingLinuxLibrary(new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by libggml-base.so)")), null);
  });

  // Runs reportNativeLoadFailure in a child whose process.platform reports the given
  // platform. The standard streams are created first, because Node creates each on
  // first use and chooses from the platform whether a pipe is written synchronously,
  // and output written asynchronously is lost when the process exits.
  const report = (platform, name) => runNode(['-e', [
    'process.stdout; process.stderr;',
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
    `require(${JSON.stringify(BIN)}).reportNativeLoadFailure(new Error(${JSON.stringify(loadError(name).message)}));`,
    "console.log('returned');",
  ].join(' ')], { cwd: REPO });

  it('exits 1 on Linux naming the missing Vulkan loader and how to install it', async () => {
    const run = await report('linux', 'libvulkan.so.1');

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [
      'Error: A native module could not load because a library it needs is missing.',
      'voxagent needs the Vulkan loader, libvulkan.so.1, on Linux.',
      'On Debian and Ubuntu, install it with: sudo apt install libvulkan1',
    ]);
  });

  it('exits 1 on Linux naming the missing GNU OpenMP runtime and how to install it', async () => {
    const run = await report('linux', 'libgomp.so.1');

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [
      'Error: A native module could not load because a library it needs is missing.',
      'voxagent needs the GNU OpenMP runtime, libgomp.so.1, on Linux.',
      'On Debian and Ubuntu, install it with: sudo apt install libgomp1',
    ]);
  });

  it('exits 1 with the loader error as it stands for a library the addon ships, and on another platform', async () => {
    for (const [platform, name] of [['linux', 'libwhisper.so.1'], ['darwin', 'libvulkan.so.1']]) {
      const run = await report(platform, name);

      assert.strictEqual(run.status, 1, describeRun(run));
      assert.deepStrictEqual(run.lines, [`Error: ${loadError(name).message}`]);
    }
  });

  // Runs voxagent --list-devices, which loads decibri first, on Linux x64 with decibri
  // failing to load because the named library is missing.
  const listDevicesWithout = (name) => runNode([BIN, '--list-devices'], {
    preload: [helper('decibri-load-failure')],
    env: { VOXAGENT_TEST_MISSING_LIBRARY: name },
    cwd: REPO,
  });

  it('exits 1 on Linux naming the missing ALSA library and how to install it when decibri cannot load', async () => {
    const run = await listDevicesWithout('libasound.so.2');

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [
      'Error: A native module could not load because a library it needs is missing.',
      'voxagent needs the ALSA library, libasound.so.2, on Linux.',
      'On Debian and Ubuntu, install it with: sudo apt install libasound2t64',
    ]);
  });

  it('exits 1 with the message decibri gives when the library it cannot find is not a known system library', async () => {
    const run = await listDevicesWithout('libunknown.so.1');

    assert.strictEqual(run.status, 1, describeRun(run));
    assert.deepStrictEqual(run.lines, [`Error: ${decibriLoadError('libunknown.so.1').message}`]);
  });
});

describe('the supported Node range and the installed dependencies', { timeout: 120000 }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const nodeModules = path.join(REPO, 'node_modules');

  function installedPackages() {
    const found = [];

    for (const entry of fs.readdirSync(nodeModules)) {
      const dirs = entry.startsWith('@') ? fs.readdirSync(path.join(nodeModules, entry)).map((name) => path.join(entry, name)) : [entry];

      for (const dir of dirs) {
        const manifest = path.join(nodeModules, dir, 'package.json');
        if (fs.existsSync(manifest)) {
          found.push(JSON.parse(fs.readFileSync(manifest, 'utf8')));
        }
      }
    }

    return found;
  }

  // util.parseArgs, which bin/voxagent.js uses, was added in Node 18.3.0.
  const API_FLOOR = '>=18.3.0';

  const VERSIONS = [
    '16.20.2', '18.0.0', '18.2.0', '18.3.0', '18.20.8', '19.0.0', '19.9.0', '20.0.0', '20.19.5',
    '21.0.0', '21.7.3', '22.0.0', '22.18.0', '23.11.1', '24.0.0', '24.8.0', '25.0.0',
  ];

  it('allows exactly the Node versions every installed dependency and every API the code uses allow', () => {
    const ranges = installedPackages()
      .filter((manifest) => manifest.engines && manifest.engines.node)
      .map((manifest) => manifest.engines.node);

    assert.ok(ranges.length > 0, 'at least one installed package declares a Node range');

    for (const version of VERSIONS) {
      const allowed = ranges.every((range) => satisfies(version, range)) && satisfies(version, API_FLOOR);
      assert.strictEqual(satisfies(version, pkg.engines.node), allowed, `Node ${version}`);
    }
  });

  it('has installed a version of each dependency that satisfies the range package.json declares', () => {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      const installed = JSON.parse(fs.readFileSync(path.join(nodeModules, name, 'package.json'), 'utf8')).version;
      assert.ok(satisfies(installed, range), `${name} ${installed} satisfies ${range}`);
    }
  });
});
