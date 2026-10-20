'use strict';

// Asks a real Ollama two questions as one conversation, with the requests built by
// lib/conversation.js and sent by lib/llm.js, of the model VOXAGENT_OLLAMA_MODEL names.
// Runs when VOXAGENT_INTEGRATION includes pipeline, and then fails if
// VOXAGENT_OLLAMA_MODEL is not set. The answers depend on the model, so no answer text
// is checked.

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const { lib } = require('../helpers/repo');
const { skipUnless } = require('../helpers/integration');
const { resolveFrom } = require('../helpers/modules');

describe('a conversation with a real Ollama', { skip: skipUnless('pipeline'), timeout: 15 * 60 * 1000 }, () => {
  const model = process.env.VOXAGENT_OLLAMA_MODEL;
  let llm;

  before(async () => {
    assert.ok(model, 'VOXAGENT_OLLAMA_MODEL names the Ollama model to ask');

    llm = require(lib('llm'));
    await llm.loadModel(model);
  });

  it('lists a context length for the model in /api/ps once the warm-up has loaded it', async () => {
    const { Ollama } = require(resolveFrom('ollama'));
    const { models } = await new Ollama().ps();
    const entry = models.find((loaded) => llm.modelMatches(model, loaded.name));

    assert.ok(entry, JSON.stringify(models));
    assert.ok(Number.isInteger(entry.context_length) && entry.context_length > 0, JSON.stringify(entry));
    assert.strictEqual(await llm.contextLength(model), entry.context_length);
  });

  it('sends the first exchange with the second question, and Ollama counts it in the second prompt', async () => {
    const { createConversation } = require(lib('conversation'));
    const conversation = createConversation({ limit: 10, contextLength: await llm.contextLength(model) });

    const firstTurn = conversation.request('What is the capital of France?');
    const first = await llm.chat(firstTurn.messages, model);

    assert.ok(conversation.add(firstTurn, first), 'the first question was answered with text');

    const secondTurn = conversation.request('How many people live there?');

    assert.deepStrictEqual(secondTurn.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);

    const second = await llm.chat(secondTurn.messages, model);
    const counts = (reply) => ({ prompt_eval_count: reply.promptEvalCount, eval_count: reply.evalCount });

    assert.ok(
      second.promptEvalCount >= first.promptEvalCount + first.evalCount,
      `first ${JSON.stringify(counts(first))}, second ${JSON.stringify(counts(second))}`,
    );
  });
});
