'use strict';

// The conversation --memory keeps for a session: the exchanges, each a question and the
// answer printed for it, the rules that decide which exchanges go to the model with the
// next question, the messages of that request, and the text the history key shows.
// Nothing here reaches Ollama or the terminal. The conversation is held in this process
// only, is never written to a file or a log, and ends when it is cleared or voxagent
// exits.

// The first message of every request with --memory. It has the model answer the latest
// question as asked and draw on the earlier exchanges only when that question refers to
// them.
const SYSTEM_MESSAGE = 'Answer the latest question. Use the earlier conversation only when the latest question refers to it.';

// The number of exchanges --context accepts, and the number kept when it is not given.
const MIN_EXCHANGES = 1;
const MAX_EXCHANGES = 50;
const DEFAULT_EXCHANGES = 10;

// The history view shows the first line of each answer up to this many characters.
const PREVIEW_LENGTH = 100;

// A token count from an Ollama response. Ollama leaves a count of zero out of the
// response, so anything other than a positive number counts as zero.
function tokenCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// The first line of an answer. A line longer than PREVIEW_LENGTH is cut at the last
// space within that length, or at that length when it holds no space, and ends with
// three dots.
function firstLine(answer) {
  const line = answer.trim().split(/\r?\n/)[0].trimEnd();

  if (line.length <= PREVIEW_LENGTH) {
    return line;
  }

  const cut = line.lastIndexOf(' ', PREVIEW_LENGTH);

  return `${line.slice(0, cut > 0 ? cut : PREVIEW_LENGTH).trimEnd()}...`;
}

// limit is the number of exchanges kept, and contextLength the context length of the
// loaded model. The exchanges kept use at most half of that length, which leaves the
// other half for the new question and its answer.
function createConversation(options) {
  const limit = options.limit;
  const contextLength = options.contextLength;
  const budget = Math.floor(contextLength / 2);

  let exchanges = [];
  let removedSinceRequest = 0;

  const sizeOf = (list) => list.reduce((total, exchange) => total + exchange.tokens, 0);

  // Removes the oldest whole exchanges until at most limit remain and their size fits
  // the budget. This can remove every exchange, when the newest alone is larger than
  // the budget.
  const trim = () => {
    while (exchanges.length > limit || (exchanges.length > 0 && sizeOf(exchanges) > budget)) {
      exchanges.shift();
      removedSinceRequest += 1;
    }
  };

  return {
    limit,
    contextLength,
    budget,

    // The exchanges kept, oldest first, as copies.
    get exchanges() {
      return exchanges.map((exchange) => ({ ...exchange }));
    },

    // The size of the exchanges kept, in tokens as Ollama counted them.
    get size() {
      return sizeOf(exchanges);
    },

    // The request for a question: the system message, then each exchange kept, oldest
    // first, as a user message and an assistant message, then the question. The turn
    // returned also records the size of the exchanges sent, which add() needs, and how
    // many exchanges were removed since the previous request.
    request(question) {
      trim();

      const sent = exchanges.slice();
      const messages = [{ role: 'system', content: SYSTEM_MESSAGE }];

      for (const exchange of sent) {
        messages.push({ role: 'user', content: exchange.question }, { role: 'assistant', content: exchange.answer });
      }

      messages.push({ role: 'user', content: question });

      const removed = removedSinceRequest;
      removedSinceRequest = 0;

      return { question, messages, sentExchanges: sent.length, sentTokens: sizeOf(sent), removed };
    },

    // Adds the exchange a turn and its reply make, and is called once the answer has
    // been printed. A reply whose answer is empty adds nothing. Ollama counts the whole
    // request, prompt and answer, so the exchange's size is that count less the size of
    // the exchanges sent with the question. Returns whether the exchange was added.
    add(turn, reply) {
      const answer = reply ? reply.content : undefined;

      if (typeof answer !== 'string' || answer.trim() === '') {
        return false;
      }

      const total = tokenCount(reply.promptEvalCount) + tokenCount(reply.evalCount);

      exchanges.push({ question: turn.question, answer, tokens: Math.max(0, total - turn.sentTokens) });
      trim();

      return true;
    },

    clear() {
      exchanges = [];
      removedSinceRequest = 0;
    },

    // The text the history key shows: the exchanges kept, numbered from the oldest, each
    // question in full and the first line of each answer.
    view() {
      if (exchanges.length === 0) {
        return 'The conversation is empty.';
      }

      const lines = [`The conversation holds ${exchanges.length} of up to ${limit} ${limit === 1 ? 'exchange' : 'exchanges'}.`];

      exchanges.forEach((exchange, index) => {
        lines.push('', `${index + 1}. You: ${exchange.question}`, `   ${firstLine(exchange.answer)}`);
      });

      return lines.join('\n');
    },
  };
}

module.exports = {
  createConversation,
  firstLine,
  SYSTEM_MESSAGE,
  MIN_EXCHANGES,
  MAX_EXCHANGES,
  DEFAULT_EXCHANGES,
  PREVIEW_LENGTH,
};
