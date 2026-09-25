'use strict';

// Integration tests run only when VOXAGENT_INTEGRATION asks for their kind, so that
// no other run needs the whisper model, the network or Ollama. The variable holds
// "all" or a comma-separated list of transcription, network and pipeline. The
// pipeline kind also needs VOXAGENT_OLLAMA_MODEL to name an installed Ollama model.

const KINDS = ['transcription', 'network', 'pipeline'];

function requested() {
  return (process.env.VOXAGENT_INTEGRATION || '')
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
}

function enabled(kind) {
  const kinds = requested();
  return kinds.includes('all') || kinds.includes(kind);
}

// The skip option for a suite of the given kind: false when it runs, otherwise the
// reason it is skipped.
function skipUnless(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown integration kind ${kind}`);
  }

  return enabled(kind) ? false : `VOXAGENT_INTEGRATION does not include ${kind}`;
}

module.exports = { KINDS, enabled, skipUnless };
