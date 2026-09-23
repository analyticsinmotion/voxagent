'use strict';

// Evaluates the version ranges package.json files use: alternatives joined by ||,
// each a list of comparators that must all hold. A comparator is a caret range
// such as ^18.3.0 or ^20, or one of >=, >, <= and < followed by a version, with or
// without a space between. Syntax outside that throws, so a range written another
// way fails the test that reads it rather than being misread.

function parseVersion(text) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());

  if (!match) {
    throw new Error(`cannot read the version '${text}'`);
  }

  return {
    parts: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)],
    given: [match[1], match[2], match[3]].filter((part) => part !== undefined).length,
  };
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

// The versions a caret range allows: at least the version given, and below the next
// change to its first non-zero part.
function caret(version) {
  const { parts, given } = parseVersion(version);
  const [major, minor] = parts;
  let upper;

  if (major > 0 || given === 1) {
    upper = [major + 1, 0, 0];
  } else if (minor > 0 || given === 2) {
    upper = [0, minor + 1, 0];
  } else {
    upper = [0, 0, parts[2] + 1];
  }

  return (v) => compare(v, parts) >= 0 && compare(v, upper) < 0;
}

function comparator(text) {
  const match = /^(\^|>=|<=|>|<)?\s*(\d+(?:\.\d+){0,2})$/.exec(text);

  if (!match) {
    throw new Error(`cannot read the comparator '${text}'`);
  }

  const [, operator, version] = match;

  if (operator === '^') {
    return caret(version);
  }

  const bound = parseVersion(version).parts;

  switch (operator) {
    case '>=':
      return (v) => compare(v, bound) >= 0;
    case '>':
      return (v) => compare(v, bound) > 0;
    case '<=':
      return (v) => compare(v, bound) <= 0;
    case '<':
      return (v) => compare(v, bound) < 0;
    default:
      return (v) => compare(v, bound) === 0;
  }
}

function satisfies(version, range) {
  const v = parseVersion(version).parts;

  return range.split('||').some((alternative) => {
    // A space between an operator and its version belongs to that comparator.
    const tokens = alternative.trim().replace(/(>=|<=|>|<|\^)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => comparator(token)(v));
  });
}

module.exports = { satisfies };
