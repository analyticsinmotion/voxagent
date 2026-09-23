'use strict';

// Checks that every export and option name voxagent passes to decibri is one the
// installed decibri declares, read from its type declarations and its module
// exports without loading its native module. A rename in decibri, such as the
// earlier change from format to dtype, fails here rather than being ignored.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { lib } = require('../helpers/repo');
const { stubModule, forget, resolveFrom } = require('../helpers/modules');
const { fakeEngine } = require('../helpers/fakes');

const entry = resolveFrom('decibri');
const declarations = fs.readFileSync(path.join(path.dirname(entry), 'decibri.d.ts'), 'utf8');
const source = fs.readFileSync(entry, 'utf8');

// The property names an exported interface declares, one per line at two spaces.
function declaredKeys(name) {
  const start = declarations.search(new RegExp(`^export interface ${name}\\b.*\\{$`, 'm'));
  assert.ok(start >= 0, `decibri declares ${name}`);

  const body = declarations.slice(start, declarations.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
}

let capture;

before(() => {
  const unused = { open: async () => { throw new Error('the default engine is not used in these tests'); } };
  stubModule('decibri', { Microphone: unused, File: unused, inputDevices: () => [] });
  forget(lib('capture'));
  capture = require(lib('capture'));
});

after(() => {
  forget('decibri');
  forget(lib('capture'));
});

// The options voxagent opens the microphone and a file with, with every optional
// setting given.
async function optionsPassed() {
  const microphone = fakeEngine({ onOpen: (mic) => mic.emit('data', Buffer.alloc(3200)), onStop: (mic) => setImmediate(() => mic.emit('end')) });
  await capture.record({ engine: microphone, noSpeechMs: 10, denoise: true, device: { id: 'x', name: 'x' } });

  const file = fakeEngine({ onOpen: (stream) => stream.emit('end') });
  await capture.readFile('question.wav', { engine: file, denoise: true });

  return { microphone: microphone.opened[0][0], file: file.opened[0][1] };
}

describe('the decibri interface voxagent uses', { timeout: 120000 }, () => {
  it('exports and declares every name lib/capture.js takes from it', () => {
    const capture = fs.readFileSync(lib('capture'), 'utf8');
    const imported = /^const \{([^}]+)\} = require\('decibri'\);$/m.exec(capture);

    assert.ok(imported, 'lib/capture.js takes named exports from decibri');

    const names = imported[1].split(',').map((part) => part.split(':')[0].trim()).filter(Boolean);
    const exported = source.slice(source.lastIndexOf('module.exports'));

    assert.deepStrictEqual(names.sort(), ['File', 'Microphone', 'inputDevices']);

    for (const name of names) {
      assert.match(exported, new RegExp(`\\b${name}\\b`), `${name} is exported`);
      assert.match(declarations, new RegExp(`^export declare (class|function) ${name}\\b`, 'm'), `${name} is declared`);
    }

    assert.match(declarations, /^ {2}static open\(options\?: MicrophoneOptions\): Promise<Microphone>;$/m);
    assert.match(declarations, /^ {2}static open\(path: string, options\?: FileOptions\): Promise<File>;$/m);
  });

  it('declares every option voxagent opens the microphone with', async () => {
    const { microphone } = await optionsPassed();
    const declared = declaredKeys('MicrophoneOptions');

    for (const key of Object.keys(microphone)) {
      assert.ok(declared.includes(key), `MicrophoneOptions declares ${key}`);
    }

    assert.match(declarations, /^ {2}device\?: number \| string \| \{ id: string \};$/m);
  });

  it('declares every option voxagent opens a file with', async () => {
    const { file } = await optionsPassed();
    const declared = declaredKeys('FileOptions');

    for (const key of Object.keys(file)) {
      assert.ok(declared.includes(key), `FileOptions declares ${key}`);
    }
  });

  it('declares every detector setting voxagent passes', async () => {
    const { microphone, file } = await optionsPassed();
    const declared = declaredKeys('VadOptions');

    for (const vad of [microphone.vad, file.vad]) {
      for (const key of Object.keys(vad)) {
        assert.ok(declared.includes(key), `VadOptions declares ${key}`);
      }
    }
  });
});
