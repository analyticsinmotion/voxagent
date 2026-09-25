'use strict';

// Decides whether a pushed tag may be published. The tag must point at the given commit,
// it must be v followed by the version in package.json at that commit, and the commit
// must be an ancestor of origin/main. Exits 0 when all three hold, 1 naming the first
// that does not, and 2 when the arguments are not usable.
//
// Usage: node verify-release.js <tag> <commit> [<repository directory>]
//
// The repository must hold origin/main and the tags, which a checkout with full history
// provides. The directory defaults to the current one.

const { spawnSync } = require('child_process');

const MAIN = 'refs/remotes/origin/main';
const USAGE = 'Usage: node verify-release.js <tag> <commit> [<repository directory>]';

class ReleaseError extends Error {}

function git(repository, args) {
  const run = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });

  if (run.error) {
    throw new ReleaseError(`git could not be run: ${run.error.message}`);
  }

  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}

// The commit a revision names, or null when it names none.
function resolveCommit(repository, revision) {
  const run = git(repository, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  return run.status === 0 ? run.stdout : null;
}

function packageVersion(repository, commit) {
  const run = git(repository, ['show', `${commit}:package.json`]);

  if (run.status !== 0) {
    throw new ReleaseError(`package.json could not be read at ${commit}: ${run.stderr}`);
  }

  let version;

  try {
    version = JSON.parse(run.stdout).version;
  } catch (err) {
    throw new ReleaseError(`package.json at ${commit} is not valid JSON: ${err.message}`);
  }

  if (typeof version !== 'string' || version === '') {
    throw new ReleaseError(`package.json at ${commit} has no version.`);
  }

  return version;
}

// Returns the line to print when the tag may be published, and throws a ReleaseError
// naming the first check that fails.
function verifyRelease(tag, commit, repository) {
  const resolved = resolveCommit(repository, commit);

  if (!resolved) {
    throw new ReleaseError(`The commit ${commit} is not in the repository.`);
  }

  const tagged = resolveCommit(repository, `refs/tags/${tag}`);

  if (!tagged) {
    throw new ReleaseError(`The tag ${tag} does not exist.`);
  }

  if (tagged !== resolved) {
    throw new ReleaseError(`The tag ${tag} points at ${tagged}, not at ${resolved}.`);
  }

  const version = packageVersion(repository, resolved);

  if (tag !== `v${version}`) {
    throw new ReleaseError(`The tag ${tag} does not match the version in package.json, which is ${version}. A release tag is v followed by that version.`);
  }

  if (!resolveCommit(repository, MAIN)) {
    throw new ReleaseError('origin/main is not in the repository. Check out with full history.');
  }

  const ancestor = git(repository, ['merge-base', '--is-ancestor', resolved, MAIN]);

  if (ancestor.status === 1) {
    throw new ReleaseError(`The commit ${resolved} is not on main.`);
  }

  if (ancestor.status !== 0) {
    throw new ReleaseError(`git merge-base failed: ${ancestor.stderr}`);
  }

  return `The tag ${tag} names version ${version} from package.json and points at ${resolved}, which is on main.`;
}

function main(argv) {
  const [tag, commit, repository = '.'] = argv;

  // GITHUB_SHA is a full SHA-1 or SHA-256 object name. Nothing shorter is accepted, so
  // the commit cannot be read as an option or as some other kind of revision.
  if (!tag || !commit || argv.length > 3 || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    console.log(verifyRelease(tag, commit, repository));
  } catch (err) {
    if (!(err instanceof ReleaseError)) {
      throw err;
    }

    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { verifyRelease, ReleaseError };
