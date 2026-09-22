'use strict';

const { Ollama } = require('ollama');

const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_HOST = 'http://127.0.0.1:11434';

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

module.exports = { checkConnection, hasModel, loadModel, ask, modelMatches, DEFAULT_MODEL };
