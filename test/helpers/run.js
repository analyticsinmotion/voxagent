'use strict';

// Runs a Node.js script in a child process and collects what it writes. Output is
// also returned with terminal colour codes removed and split into its non-empty
// lines, which is the form most assertions read.

const { spawn } = require('child_process');

const ANSI = /\x1b\[[0-9;]*m/g;

function runNode(args, options) {
  const settings = { env: {}, preload: [], input: '', cwd: undefined, timeoutMs: 60000, ...options };
  const preloadArgs = settings.preload.flatMap((file) => ['--require', file]);
  const env = { ...process.env, ...settings.env };

  // The test runner marks its own child processes through this variable, and a
  // process started here is not a test file.
  delete env.NODE_TEST_CONTEXT;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preloadArgs, ...args], {
      cwd: settings.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, settings.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (status, signal) => {
      clearTimeout(timer);
      const output = (stdout + stderr).replace(ANSI, '');
      resolve({
        status,
        signal,
        timedOut,
        stdout,
        stderr,
        output,
        lines: output.split(/\r?\n/).filter((line) => line.trim() !== ''),
      });
    });

    child.stdin.end(settings.input);
  });
}

// A description of a finished run for an assertion message.
function describeRun(run) {
  return `exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}${run.timedOut ? ', timed out' : ''}\n${run.output}`;
}

module.exports = { runNode, describeRun };
