'use strict';

// Runs the whole pipeline: node bin/voxagent.js --file on the fixture, with the
// real decibri, whisper and Ollama, asking the model VOXAGENT_OLLAMA_MODEL names.
// Runs when VOXAGENT_INTEGRATION includes pipeline, and then fails if
// VOXAGENT_OLLAMA_MODEL is not set.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BIN, REPO, FIXTURE, FIXTURE_TEXT } = require('../helpers/repo');
const { skipUnless } = require('../helpers/integration');
const { runNode, describeRun } = require('../helpers/run');

describe('the full pipeline', { skip: skipUnless('pipeline'), timeout: 20 * 60 * 1000 }, () => {
  it('prints the exact transcript and an answer for the fixture and exits 0', async () => {
    const model = process.env.VOXAGENT_OLLAMA_MODEL;

    assert.ok(model, 'VOXAGENT_OLLAMA_MODEL names the Ollama model to ask');

    const run = await runNode([BIN, '--file', FIXTURE, '--model', model], { cwd: REPO, timeoutMs: 15 * 60 * 1000 });

    assert.strictEqual(run.status, 0, describeRun(run));
    assert.ok(run.lines.includes(`You: ${FIXTURE_TEXT}`), describeRun(run));

    const answer = run.lines.slice(run.lines.indexOf('Thinking...') + 1).join('\n').trim();

    assert.ok(run.lines.includes('Thinking...'), describeRun(run));
    assert.ok(answer.length > 0, describeRun(run));
  });
});
