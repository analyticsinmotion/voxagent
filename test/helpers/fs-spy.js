'use strict';

// Records every filesystem call that can create or change a file, so a test can
// show where data was written. Calls on a path are kept apart from writes to a
// descriptor, because a write to descriptor 1 or 2 is terminal output.
//
// Required by a test, install() starts recording in that process. Loaded with
// --require, it records in the process it is loaded into and writes the calls as
// JSON to <VOXAGENT_TEST_FS_LOG>.<pid>.json when that process exits.

const fs = require('fs');

const PATH_METHODS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createWriteStream', 'open', 'openSync', 'copyFile', 'copyFileSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rename', 'renameSync',
  'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
];

const FD_METHODS = ['write', 'writeSync', 'writev', 'writevSync', 'ftruncate', 'ftruncateSync'];

// An open for reading is not a write, so open is recorded only with a flag that
// creates, truncates, appends or writes.
function writesWithFlags(flags) {
  if (flags === undefined || flags === null) {
    return false;
  }

  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }

  return /[wa+]/.test(String(flags));
}

function install() {
  const calls = [];
  const originals = {};

  for (const name of PATH_METHODS) {
    const real = fs[name];
    originals[name] = real;
    fs[name] = function recorded(...args) {
      if (!name.startsWith('open') || writesWithFlags(args[1])) {
        calls.push({ kind: 'path', method: name, target: String(args[0]) });
      }
      return real.apply(this, args);
    };
  }

  for (const name of FD_METHODS) {
    const real = fs[name];
    originals[name] = real;
    fs[name] = function recorded(...args) {
      calls.push({ kind: 'fd', method: name, target: String(args[0]) });
      return real.apply(this, args);
    };
  }

  return {
    calls,
    pathWrites: () => calls.filter((call) => call.kind === 'path'),
    restore() {
      for (const [name, real] of Object.entries(originals)) {
        fs[name] = real;
      }
    },
  };
}

module.exports = { install };

// A module loaded with --require runs before the main module exists.
if (process.env.VOXAGENT_TEST_FS_LOG && require.main === undefined) {
  const realWriteFileSync = fs.writeFileSync;
  const spy = install();

  process.on('exit', () => {
    realWriteFileSync(`${process.env.VOXAGENT_TEST_FS_LOG}.${process.pid}.json`, JSON.stringify({ argv: process.argv, calls: spy.calls }));
  });
}
