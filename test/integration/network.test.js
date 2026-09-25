'use strict';

// Checks the whisper model pin against the model host: the SHA-256 and size
// lib/model.js pins are the values the host publishes for the pinned revision, and
// the pinned URL serves a file of that size. Runs when VOXAGENT_INTEGRATION
// includes network.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const https = require('https');

const { lib } = require('../helpers/repo');
const { skipUnless } = require('../helpers/integration');

const { MODEL_URL, MODEL_SHA256, MODEL_BYTES } = require(lib('model'));

// Makes a request and follows redirects, resolving each Location against the URL
// that returned it. The body is kept only for a GET.
function request(method, url, redirects) {
  const left = redirects === undefined ? 5 : redirects;

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'user-agent': 'voxagent-tests' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
        res.resume();
        request(method, new URL(res.headers.location, url).href, left - 1).then(resolve, reject);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (data) => {
        if (method === 'GET') {
          body += data;
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });

    req.on('error', reject);
    req.end();
  });
}

describe('the pinned whisper model', { skip: skipUnless('network'), timeout: 5 * 60 * 1000 }, () => {
  const match = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/([^/]+)$/.exec(MODEL_URL);

  it('is fetched from a URL that names a repository, a commit revision and a file', () => {
    assert.ok(match, MODEL_URL);
  });

  it('has the SHA-256 and size the model host publishes for the pinned revision', async () => {
    const [, repository, revision, file] = match;
    const tree = await request('GET', `https://huggingface.co/api/models/${repository}/tree/${revision}`);

    assert.strictEqual(tree.status, 200, tree.body.slice(0, 200));

    const entry = JSON.parse(tree.body).find((item) => item.path === file);

    assert.ok(entry, `the revision lists ${file}`);
    assert.strictEqual(entry.lfs.oid, MODEL_SHA256);
    assert.strictEqual(entry.lfs.size, MODEL_BYTES);
    assert.strictEqual(entry.size, MODEL_BYTES);
  });

  it('is served at the pinned URL with the pinned size', async () => {
    const head = await request('HEAD', MODEL_URL);

    assert.strictEqual(head.status, 200);
    assert.strictEqual(Number(head.headers['content-length']), MODEL_BYTES);
  });
});
