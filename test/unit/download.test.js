'use strict';

// Checks the whisper model download against a local server: a correct file is
// renamed into place, every kind of bad body is refused and leaves no file, the
// temporary file is closed before it is removed, a failure to remove it is reported,
// a model file of the wrong size is replaced, and redirects are followed within a
// limit.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { lib } = require('../helpers/repo');
const { listen, close } = require('../helpers/servers');
const { captureModelOutput } = require('../helpers/fakes');

const { ensureModel } = require(lib('model'));

const BODY = crypto.randomBytes(4096);
const SHA256 = crypto.createHash('sha256').update(BODY).digest('hex');
const EXPECTED = { sha256: SHA256, bytes: BODY.length };

let server;
let base;
let dir;
let output;
let watch;

// Records, in order, every open of a temporary download file with the descriptor it
// returned, every completed close of one of those descriptors, and every call that
// removes a temporary download file, with the descriptors still open at that moment.
// The download and its write stream reach the file through these fs functions. With
// removeFirst, the file is deleted just before each removal runs, so the removal
// finds it already gone.
function watchTemporaryFile(options) {
  const settings = { removeFirst: false, ...options };
  const events = [];
  const openDescriptors = new Set();
  const real = {};
  const isTemporary = (target) => String(target).endsWith('.tmp');

  const replace = (name, wrapper) => {
    real[name] = fs[name];
    fs[name] = wrapper;
  };

  replace('open', function watchedOpen(target, ...rest) {
    const callback = rest[rest.length - 1];

    if (isTemporary(target) && typeof callback === 'function') {
      rest[rest.length - 1] = (err, fd) => {
        if (!err) {
          openDescriptors.add(fd);
          events.push({ event: 'open', fd });
        }
        callback(err, fd);
      };
    }

    return real.open.call(this, target, ...rest);
  });

  replace('close', function watchedClose(fd, callback) {
    if (!openDescriptors.has(fd)) {
      return real.close.call(this, fd, callback);
    }

    return real.close.call(this, fd, (err) => {
      if (!err) {
        openDescriptors.delete(fd);
        events.push({ event: 'close', fd });
      }
      if (callback) {
        callback(err);
      }
    });
  });

  for (const name of ['unlink', 'unlinkSync', 'rm', 'rmSync']) {
    replace(name, function watchedRemove(target, ...rest) {
      if (isTemporary(target)) {
        events.push({ event: 'remove', method: name, stillOpen: [...openDescriptors] });

        if (settings.removeFirst) {
          try {
            real.unlinkSync(target);
          } catch (err) {
            // The file does not exist yet, which leaves the removal to find it gone.
          }
        }
      }

      return real[name].call(this, target, ...rest);
    });
  }

  return {
    events,
    stillOpen: () => [...openDescriptors],
    restore() {
      for (const [name, fn] of Object.entries(real)) {
        fs[name] = fn;
      }
    },
  };
}

// The temporary file was opened, every descriptor opened on it was closed before
// the first call that removed it, and none is left open.
function assertClosedBeforeRemoval(watched) {
  const events = watched.events;
  const firstRemoval = events.findIndex((entry) => entry.event === 'remove');
  const opens = events.filter((entry) => entry.event === 'open');

  assert.ok(opens.length > 0, `the temporary file was opened: ${JSON.stringify(events)}`);
  assert.ok(firstRemoval >= 0, `the temporary file was removed: ${JSON.stringify(events)}`);

  for (const opened of opens) {
    const closedAt = events.findIndex((entry) => entry.event === 'close' && entry.fd === opened.fd);
    assert.ok(closedAt >= 0 && closedAt < firstRemoval, `descriptor ${opened.fd} was closed before the file was removed: ${JSON.stringify(events)}`);
  }

  assert.deepStrictEqual(watched.stillOpen(), [], 'no descriptor of the temporary file is left open');
}

// Routes:
//   /file              the correct body
//   /short             a content-length of the full body and half of it sent
//   /wrong-length      a complete, consistent body of the wrong length
//   /flipped           the right length with one byte changed
//   /status/<code>     a redirect with an absolute Location to /file
//   /relative/<code>   the same redirect with a relative Location
//   /hops/<n>          a chain of n redirects ending at /file
//   /no-location       a 302 with no Location header
//   /bad-location      a 302 whose Location is not a valid URL
function route(req, res) {
  const status = /^\/status\/(\d+)$/.exec(req.url);
  const relative = /^\/relative\/(\d+)$/.exec(req.url);
  const hops = /^\/hops\/(\d+)$/.exec(req.url);

  if (req.url === '/file') {
    res.writeHead(200, { 'content-length': BODY.length });
    res.end(BODY);
  } else if (req.url === '/short') {
    res.writeHead(200, { 'content-length': BODY.length });
    res.write(BODY.subarray(0, BODY.length / 2));
    // Ending the socket after half the declared length is a transfer cut short.
    res.socket.end();
  } else if (req.url === '/wrong-length') {
    const other = crypto.randomBytes(BODY.length / 2);
    res.writeHead(200, { 'content-length': other.length });
    res.end(other);
  } else if (req.url === '/flipped') {
    const flipped = Buffer.from(BODY);
    flipped[100] ^= 0xff;
    res.writeHead(200, { 'content-length': flipped.length });
    res.end(flipped);
  } else if (status) {
    res.writeHead(Number(status[1]), { location: `${base}/file` });
    res.end();
  } else if (relative) {
    res.writeHead(Number(relative[1]), { location: '/file' });
    res.end();
  } else if (hops) {
    const n = Number(hops[1]);
    res.writeHead(302, { location: n <= 1 ? `${base}/file` : `${base}/hops/${n - 1}` });
    res.end();
  } else if (req.url === '/no-location') {
    res.writeHead(302);
    res.end();
  } else if (req.url === '/bad-location') {
    res.writeHead(302, { location: 'http://[not-a-host' });
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
}

before(async () => {
  server = http.createServer(route);
  base = await listen(server);
});

after(async () => {
  await close(server);
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxagent-download-'));
  output = captureModelOutput();
});

afterEach(() => {
  if (watch) {
    watch.restore();
    watch = null;
  }
  output.restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fetchTo(route, name) {
  const dest = path.join(dir, name || 'model.bin');
  return { dest, done: ensureModel({ url: `${base}${route}`, dest, ...EXPECTED }) };
}

function assertNoFile(dest) {
  assert.strictEqual(fs.existsSync(dest), false, 'no model file is left');
  assert.strictEqual(fs.existsSync(`${dest}.tmp`), false, 'no temporary file is left');
}

describe('the download', { timeout: 120000 }, () => {
  it('renames a correct file into place and leaves no temporary file', async () => {
    const { dest, done } = fetchTo('/file');

    assert.strictEqual(await done, dest);
    assert.ok(fs.readFileSync(dest).equals(BODY));
    assert.strictEqual(fs.existsSync(`${dest}.tmp`), false);
  });

  it('refuses a body cut short, closes the temporary file before removing it, and leaves no file', async () => {
    watch = watchTemporaryFile();
    const { dest, done } = fetchTo('/short');

    await assert.rejects(done, /download did not complete.*Run voxagent again/);
    assertClosedBeforeRemoval(watch);
    assertNoFile(dest);
  });

  it('refuses a complete body of the wrong length, closes the temporary file before removing it, and leaves no file', async () => {
    watch = watchTemporaryFile();
    const { dest, done } = fetchTo('/wrong-length');

    await assert.rejects(done, /download incomplete, 2048 bytes received where 4096 is expected/);
    assertClosedBeforeRemoval(watch);
    assertNoFile(dest);
  });

  it('refuses a body of the right length with one byte changed, closes the temporary file before removing it, and leaves no file', async () => {
    watch = watchTemporaryFile();
    const { dest, done } = fetchTo('/flipped');

    await assert.rejects(done, /download corrupt, SHA-256 [0-9a-f]{64} where [0-9a-f]{64} is expected/);
    assertClosedBeforeRemoval(watch);
    assertNoFile(dest);
  });

  it('reports only the download error when the temporary file is already gone as it is removed', async () => {
    watch = watchTemporaryFile({ removeFirst: true });
    const { dest, done } = fetchTo('/short');

    await assert.rejects(done, (err) => {
      assert.match(err.message, /^download did not complete, .*\. Run voxagent again to download it again\.$/);
      return true;
    });
    assertClosedBeforeRemoval(watch);
    assertNoFile(dest);
  });

  it('reports a temporary file it cannot remove together with the download error', async () => {
    const dest = path.join(dir, 'model.bin');
    const tmp = `${dest}.tmp`;

    // A directory where the temporary file belongs can be neither opened as the file
    // nor removed as one.
    fs.mkdirSync(tmp);

    await assert.rejects(ensureModel({ url: `${base}/file`, dest, ...EXPECTED }), (err) => {
      assert.ok(err.cause && err.cause.syscall === 'open', `the download error is the failed open: ${err.stack}`);
      assert.ok(err.message.startsWith(`${err.cause.message} The partial download ${tmp} could not be removed: `), err.message);
      return true;
    });
    assert.ok(fs.statSync(tmp).isDirectory());
    assert.strictEqual(fs.existsSync(dest), false);
  });
});

describe('a model file already on disk', { timeout: 120000 }, () => {
  it('is replaced when its size is wrong', async () => {
    const dest = path.join(dir, 'model.bin');
    fs.writeFileSync(dest, Buffer.alloc(1234));

    await ensureModel({ url: `${base}/file`, dest, ...EXPECTED });

    assert.ok(fs.readFileSync(dest).equals(BODY));
    assert.ok(output.lines.includes('Whisper model is 1234 bytes where 4096 is expected. Downloading it again.\n'));
  });

  it('is used as it stands when its size is right, with no request made', async () => {
    const dest = path.join(dir, 'model.bin');
    const existing = Buffer.alloc(BODY.length, 7);
    fs.writeFileSync(dest, existing);

    assert.strictEqual(await ensureModel({ url: `${base}/missing`, dest, ...EXPECTED }), dest);
    assert.ok(fs.readFileSync(dest).equals(existing));
  });
});

describe('redirects', { timeout: 120000 }, () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`follows a ${status} with an absolute Location`, async () => {
      const { dest, done } = fetchTo(`/status/${status}`);

      await done;
      assert.ok(fs.readFileSync(dest).equals(BODY));
    });

    it(`follows a ${status} with a relative Location`, async () => {
      const { dest, done } = fetchTo(`/relative/${status}`);

      await done;
      assert.ok(fs.readFileSync(dest).equals(BODY));
    });
  }

  it('follows five redirects in a chain', async () => {
    const { dest, done } = fetchTo('/hops/5');

    await done;
    assert.ok(fs.readFileSync(dest).equals(BODY));
  });

  it('refuses a sixth redirect and leaves no file', async () => {
    const { dest, done } = fetchTo('/hops/6');

    await assert.rejects(done, /Too many redirects/);
    assertNoFile(dest);
  });

  it('fails on a redirect with no Location, naming its status, and leaves no file', async () => {
    const { dest, done } = fetchTo('/no-location');

    await assert.rejects(done, /Download failed: HTTP 302/);
    assertNoFile(dest);
  });

  it('fails on a redirect to a Location that is not a valid URL, and leaves no file', async () => {
    const { dest, done } = fetchTo('/bad-location');

    await assert.rejects(done, /Download failed: HTTP 302 redirected to an invalid location/);
    assertNoFile(dest);
  });
});
