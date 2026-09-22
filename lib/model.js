'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_DIR = path.join(os.homedir(), '.voxagent', 'models');
const MODEL_FILE = 'ggml-base.en.bin';

// The download is pinned to one revision rather than to a branch, so the bytes fetched
// cannot change under the hash below. The hash and the size are the values the model host
// publishes for this file at this revision.
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${MODEL_FILE}`;
const MODEL_SHA256 = 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002';
const MODEL_BYTES = 147964211;

// Every redirect status that names a new location for a GET. 307 and 308 preserve the
// method across the redirect and are what a host is most likely to move to, so a host
// that switched to one of them would otherwise fail rather than being followed.
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function getModelPath() {
  return path.join(MODEL_DIR, MODEL_FILE);
}

// A body that is cut short but ends cleanly satisfies the stream's own finish event, so
// the byte count is checked against both the pinned size and the size the server declared,
// and the hash is checked against the pinned value. Returns null when the file is sound.
function checkDownload(bytes, sha256, declaredBytes, expected) {
  if (declaredBytes > 0 && bytes !== declaredBytes) {
    return `download incomplete, ${bytes} bytes received where the server declared ${declaredBytes}`;
  }

  if (bytes !== expected.bytes) {
    return `download incomplete, ${bytes} bytes received where ${expected.bytes} is expected`;
  }

  if (sha256 !== expected.sha256) {
    return `download corrupt, SHA-256 ${sha256} where ${expected.sha256} is expected`;
  }

  return null;
}

function download(url, dest, expected, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;

  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Too many redirects'));
    }

    const proto = url.startsWith('https') ? https : http;
    const tmpDest = dest + '.tmp';

    proto.get(url, (res) => {
      if (REDIRECT_STATUSES.includes(res.statusCode)) {
        res.resume();
        return download(res.headers.location, dest, expected, maxRedirects - 1).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      const hash = crypto.createHash('sha256');
      const file = fs.createWriteStream(tmpDest);

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        hash.update(chunk);
        if (totalBytes > 0) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          const dlMB = (downloadedBytes / 1048576).toFixed(1);
          const totalMB = (totalBytes / 1048576).toFixed(1);
          process.stdout.write(`\rDownloading whisper model... ${dlMB} MB / ${totalMB} MB (${pct}%)`);
        } else {
          const dlMB = (downloadedBytes / 1048576).toFixed(1);
          process.stdout.write(`\rDownloading whisper model... ${dlMB} MB`);
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n');

          const problem = checkDownload(downloadedBytes, hash.digest('hex'), totalBytes, expected);

          if (problem) {
            fs.unlinkSync(tmpDest);
            return reject(new Error(`${problem}. Run voxagent again to download it again.`));
          }

          fs.renameSync(tmpDest, dest);
          resolve();
        });
      });

      file.on('error', (err) => {
        fs.unlink(tmpDest, () => {});
        reject(err);
      });

      // A transfer that ends before the declared length reaches this handler as an
      // aborted response, which is a mismatch the byte count below never gets to see,
      // so the retry advice is attached here as well.
      res.on('error', (err) => {
        fs.unlink(tmpDest, () => {});
        reject(new Error(`download did not complete, ${err.message}. Run voxagent again to download it again.`));
      });
    }).on('error', reject);
  });
}

// The overrides argument names the source, the expected bytes and the destination, so the
// same code can be run against a file other than the published model.
async function ensureModel(overrides) {
  const settings = Object.assign(
    { url: MODEL_URL, sha256: MODEL_SHA256, bytes: MODEL_BYTES, dest: getModelPath() },
    overrides
  );

  if (fs.existsSync(settings.dest)) {
    const actualBytes = fs.statSync(settings.dest).size;

    if (actualBytes === settings.bytes) {
      return settings.dest;
    }

    // One stat call rules out a truncated file on every start, where hashing the whole
    // model would cost about a second each time. A file of the wrong size cannot be the
    // pinned model, so it is replaced.
    process.stdout.write(`Whisper model is ${actualBytes} bytes where ${settings.bytes} is expected. Downloading it again.\n`);
    fs.unlinkSync(settings.dest);
  } else {
    process.stdout.write('Whisper model not found.\n');
  }

  fs.mkdirSync(path.dirname(settings.dest), { recursive: true });

  process.stdout.write('Downloading base.en (~150 MB)...\n');
  await download(settings.url, settings.dest, { sha256: settings.sha256, bytes: settings.bytes });
  process.stdout.write('Model downloaded successfully.\n');

  return settings.dest;
}

module.exports = { getModelPath, ensureModel, checkDownload, MODEL_URL, MODEL_SHA256, MODEL_BYTES };
