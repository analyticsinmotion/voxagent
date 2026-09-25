'use strict';

// Loaded with --require before bin/voxagent.js, so the program runs with the real
// decibri, whisper addon and whisper model and a stand-in Ollama client. The
// stand-in lists llama3.2 as installed and answers every question with the text in
// VOXAGENT_TEST_ANSWER.

const { stubModule } = require('./modules');

class StubOllama {
  async list() {
    return { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] };
  }

  async generate() {
    return { response: '', done: true };
  }

  async chat() {
    return { message: { role: 'assistant', content: process.env.VOXAGENT_TEST_ANSWER } };
  }
}

stubModule('ollama', { Ollama: StubOllama });
