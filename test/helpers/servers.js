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

// Lists the given model names, and answers every chat with the given text. options.ps is
// the list of loaded models /api/ps returns, and options.counts holds the count fields
// every chat answer carries. Each request is kept in server.requests as { url, body },
// with the body parsed from JSON, or null when it is empty.
function ollamaServer(names, answer, options) {
  const settings = { ps: [], counts: {}, ...options };
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');

      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: names.map((name) => ({ name, model: name })) }));
        return;
      }

      if (req.url === '/api/ps') {
        res.end(JSON.stringify({ models: settings.ps }));
        return;
      }

      if (req.url === '/api/chat') {
        res.end(JSON.stringify({ message: { role: 'assistant', content: answer || 'ok' }, done: true, ...settings.counts }));
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });
  });

  server.requests = requests;

  return server;
}

module.exports = { listen, close, ollamaServer };
