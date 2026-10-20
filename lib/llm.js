'use strict';

const { Ollama } = require('ollama');

const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_HOST = 'http://127.0.0.1:11434';

// The context length used for a model that /api/ps lists with no length or does not list,
// as for a cloud model.
const FALLBACK_CONTEXT_LENGTH = 4096;

let client = null;
let clientHost = null;

// One client is built on first use and reused for every later call, so the connections it
// opens are shared. Each exported call takes an optional host, so a client can be built
// for a server other than the default one.
function getClient(host) {
  const target = host || DEFAULT_HOST;

  if (client === null || clientHost !== target) {
    client = new Ollama({ host: target });
    clientHost = target;
  }

  return client;
}

async function checkConnection(host) {
  try {
    await getClient(host).list();
    return true;
  } catch {
    return false;
  }
}

// Ollama lists a model pulled as "llama3.2" under the name "llama3.2:latest", so a request
// carrying no tag matches the ":latest" entry as well as the bare name. A listed name that
// merely starts with the request, such as "llama3.2-vision:latest", is a different model
// and does not match.
function modelMatches(requested, listed) {
  if (listed === requested) {
    return true;
  }

  return !requested.includes(':') && listed === `${requested}:latest`;
}

async function hasModel(model, host) {
  const { models } = await getClient(host).list();

  return models.some((entry) => modelMatches(model, entry.name));
}

// A generate call with an empty prompt loads the model into memory and returns without
// producing any text, so the first answer does not pay the model load.
async function loadModel(model, host) {
  await getClient(host).generate({ model: model || DEFAULT_MODEL, prompt: '' });
}

async function ask(text, model, host) {
  const response = await getClient(host).chat({
    model: model || DEFAULT_MODEL,
    messages: [{ role: 'user', content: text }],
  });

  return response.message.content;
}

// Sends a list of messages, oldest first, and returns the answer together with the
// counts and durations Ollama reports for the request. Durations are in nanoseconds,
// and a value Ollama leaves out is undefined. The request carries the model and the
// messages and no options, so the model answers with the settings the warm-up loaded
// it with and is not loaded again. Only the answer text is returned, never any
// thinking a model reports beside it.
async function chat(messages, model, host) {
  const response = await getClient(host).chat({
    model: model || DEFAULT_MODEL,
    messages,
  });

  return {
    content: response.message.content,
    promptEvalCount: response.prompt_eval_count,
    promptEvalCachedCount: response.prompt_eval_cached_count,
    evalCount: response.eval_count,
    loadDuration: response.load_duration,
    promptEvalDuration: response.prompt_eval_duration,
  };
}

// The context length /api/ps reports for the model, which is read once the model is
// loaded. FALLBACK_CONTEXT_LENGTH is returned when the listing does not include the
// model, gives it no length, or cannot be read.
async function contextLength(model, host) {
  let listing;

  try {
    listing = await getClient(host).ps();
  } catch {
    return FALLBACK_CONTEXT_LENGTH;
  }

  const requested = model || DEFAULT_MODEL;
  const entry = ((listing && listing.models) || []).find((loaded) => modelMatches(requested, loaded.name));
  const length = entry ? entry.context_length : undefined;

  return Number.isInteger(length) && length > 0 ? length : FALLBACK_CONTEXT_LENGTH;
}

module.exports = { checkConnection, hasModel, loadModel, ask, chat, contextLength, modelMatches, DEFAULT_MODEL, FALLBACK_CONTEXT_LENGTH };
