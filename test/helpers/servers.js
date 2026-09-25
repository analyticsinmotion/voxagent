'use strict';

// Local HTTP servers for the tests: one that answers as Ollama does and one that
// serves a download, both on a free port on the loopback address.

const http = require('http');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Lists the given model names, and answers every chat with the given text.
function ollamaServer(names, answer) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');

    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: names.map((name) => ({ name, model: name })) }));
      return;
    }

    if (req.url === '/api/chat') {
      req.resume();
      req.on('end', () => res.end(JSON.stringify({ message: { role: 'assistant', content: answer || 'ok' }, done: true })));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });

  return server;
}

module.exports = { listen, close, ollamaServer };
