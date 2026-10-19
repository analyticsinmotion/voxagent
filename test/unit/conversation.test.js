'use strict';

// Checks lib/conversation.js, the conversation --memory keeps: the messages of each
// request, the limit on the number of exchanges, the size of each exchange from the
// counts Ollama reports and the budget of half the context length, that only an
// answered question becomes an exchange, the history view and clearing.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { lib } = require('../helpers/repo');

const { createConversation, firstLine, SYSTEM_MESSAGE, MIN_EXCHANGES, MAX_EXCHANGES, DEFAULT_EXCHANGES } = require(lib('conversation'));

// A reply as lib/llm.js returns it, with the counts Ollama reports.
const reply = (content, promptEvalCount, evalCount) => ({ content, promptEvalCount, evalCount });

// Asks a question and adds its answer, with the counts given.
function exchange(conversation, question, answer, promptEvalCount, evalCount) {
  const turn = conversation.request(question);
  conversation.add(turn, reply(answer, promptEvalCount, evalCount));
  return turn;
}

const questions = (turn) => turn.messages.filter((message) => message.role === 'user').map((message) => message.content);

describe('the request messages', () => {
  it('start with the system message, carry the exchanges kept oldest first, and end with the new question', () => {
    const conversation = createConversation({ limit: 10, contextLength: 4096 });

    const first = exchange(conversation, 'What is the capital of Australia?', 'The capital of Australia is Canberra.', 40, 9);
    assert.deepStrictEqual(first.messages, [
      { role: 'system', content: SYSTEM_MESSAGE },
      { role: 'user', content: 'What is the capital of Australia?' },
    ]);

    exchange(conversation, 'How many people live there?', 'About 470,000 people live in Canberra.', 70, 12);

    assert.deepStrictEqual(conversation.request('Who designed it?').messages, [
      { role: 'system', content: SYSTEM_MESSAGE },
      { role: 'user', content: 'What is the capital of Australia?' },
      { role: 'assistant', content: 'The capital of Australia is Canberra.' },
      { role: 'user', content: 'How many people live there?' },
      { role: 'assistant', content: 'About 470,000 people live in Canberra.' },
      { role: 'user', content: 'Who designed it?' },
    ]);
  });

  it('use this system message', () => {
    assert.strictEqual(SYSTEM_MESSAGE, 'Answer the latest question. Use the earlier conversation only when the latest question refers to it.');
  });
});

describe('the limit on exchanges', () => {
  it('is 10 by default, and --context accepts 1 to 50', () => {
    assert.deepStrictEqual([DEFAULT_EXCHANGES, MIN_EXCHANGES, MAX_EXCHANGES], [10, 1, 50]);
  });

  it('keeps at most the limit, removing the oldest exchange first', () => {
    const conversation = createConversation({ limit: 3, contextLength: 4096 });

    for (let n = 1; n <= 5; n++) {
      exchange(conversation, `Question ${n}?`, `Answer ${n}.`, 10 * n, 5);
      assert.ok(conversation.exchanges.length <= 3);
    }

    assert.deepStrictEqual(conversation.exchanges.map((kept) => kept.question), ['Question 3?', 'Question 4?', 'Question 5?']);
    assert.deepStrictEqual(questions(conversation.request('Question 6?')), ['Question 3?', 'Question 4?', 'Question 5?', 'Question 6?']);
  });

  it('sends every exchange kept with the next question, so a limit of 1 keeps one exchange for a follow-up', () => {
    const conversation = createConversation({ limit: 1, contextLength: 4096 });

    exchange(conversation, 'Who wrote Pride and Prejudice?', 'Jane Austen wrote it.', 30, 6);

    const second = exchange(conversation, 'When was she born?', 'She was born in 1775.', 50, 8);
    assert.deepStrictEqual(questions(second), ['Who wrote Pride and Prejudice?', 'When was she born?']);

    const third = conversation.request('Where?');
    assert.deepStrictEqual(questions(third), ['When was she born?', 'Where?']);
  });

  it('reports with each request how many exchanges were removed since the previous request', () => {
    const conversation = createConversation({ limit: 2, contextLength: 4096 });

    assert.strictEqual(exchange(conversation, 'One?', 'One.', 10, 2).removed, 0);
    assert.strictEqual(exchange(conversation, 'Two?', 'Two.', 20, 2).removed, 0);
    assert.strictEqual(exchange(conversation, 'Three?', 'Three.', 30, 2).removed, 0);
    assert.strictEqual(conversation.request('Four?').removed, 1);
    assert.strictEqual(conversation.request('Four?').removed, 0);
  });
});

describe('the size of each exchange and the budget', () => {
  it('sizes an exchange as Ollama counted the request, prompt and answer, less the exchanges sent with it', () => {
    const conversation = createConversation({ limit: 10, contextLength: 4096 });

    const first = exchange(conversation, 'What is the capital of France?', 'Paris.', 32, 8);
    assert.strictEqual(first.sentTokens, 0);

    const second = exchange(conversation, 'How many people live there?', 'About two million.', 55, 63);
    assert.strictEqual(second.sentTokens, 40);

    assert.deepStrictEqual(conversation.exchanges.map((kept) => kept.tokens), [40, 78]);
    assert.strictEqual(conversation.size, 118);
  });

  it('allows the exchanges half of the context length', () => {
    assert.strictEqual(createConversation({ limit: 10, contextLength: 4096 }).budget, 2048);
    assert.strictEqual(createConversation({ limit: 10, contextLength: 16384 }).budget, 8192);
  });

  it('removes the oldest exchanges until the rest fit the budget', () => {
    const conversation = createConversation({ limit: 10, contextLength: 200 });

    exchange(conversation, 'One?', 'One.', 40, 9);
    exchange(conversation, 'Two?', 'Two.', 70, 30);
    assert.deepStrictEqual(conversation.exchanges.map((kept) => kept.tokens), [49, 51]);

    exchange(conversation, 'Three?', 'Three.', 120, 30);
    assert.deepStrictEqual(conversation.exchanges.map((kept) => kept.question), ['Three?']);
    assert.strictEqual(conversation.size, 50);

    const next = conversation.request('Four?');
    assert.strictEqual(next.removed, 2);
    assert.deepStrictEqual(questions(next), ['Three?', 'Four?']);
  });

  it('keeps no exchange that is larger than the budget by itself', () => {
    const conversation = createConversation({ limit: 10, contextLength: 100 });

    exchange(conversation, 'Tell me a story.', 'Once upon a time.', 40, 30);

    assert.strictEqual(conversation.exchanges.length, 0);
    assert.deepStrictEqual(questions(conversation.request('And then?')), ['And then?']);
  });

  it('sizes an exchange at zero when the reply carries no counts, which leaves the limit on exchanges in force', () => {
    const conversation = createConversation({ limit: 2, contextLength: 100 });

    for (const question of ['One?', 'Two?', 'Three?']) {
      const turn = conversation.request(question);
      conversation.add(turn, { content: 'An answer.' });
    }

    assert.deepStrictEqual(conversation.exchanges.map((kept) => [kept.question, kept.tokens]), [['Two?', 0], ['Three?', 0]]);
  });
});

describe('adding an exchange', () => {
  it('adds a question only together with an answer that has text', () => {
    const conversation = createConversation({ limit: 10, contextLength: 4096 });

    for (const content of ['', '  \n ', undefined, null, 42]) {
      const turn = conversation.request('A question?');
      assert.strictEqual(conversation.add(turn, { content, promptEvalCount: 30, evalCount: 0 }), false);
    }

    assert.strictEqual(conversation.add(conversation.request('A question?'), null), false);
    assert.strictEqual(conversation.exchanges.length, 0);

    assert.strictEqual(conversation.add(conversation.request('A question?'), reply('An answer.', 30, 4)), true);
    assert.deepStrictEqual(conversation.exchanges.map((kept) => [kept.question, kept.answer]), [['A question?', 'An answer.']]);
  });

  it('adds nothing for a question that is asked and never answered', () => {
    const conversation = createConversation({ limit: 10, contextLength: 4096 });

    exchange(conversation, 'One?', 'One.', 20, 2);
    conversation.request('Two?');

    assert.deepStrictEqual(questions(conversation.request('Three?')), ['One?', 'Three?']);
  });
});

describe('the history view', () => {
  it('prints that the conversation is empty when it holds no exchange', () => {
    assert.strictEqual(createConversation({ limit: 10, contextLength: 4096 }).view(), 'The conversation is empty.');
  });

  it('gives the count and the limit, then each exchange numbered from the oldest, with its question in full and the first line of its answer', () => {
    const conversation = createConversation({ limit: 10, contextLength: 4096 });

    exchange(conversation, 'What is the capital of Australia?', 'The capital of Australia is Canberra.', 40, 9);
    exchange(
      conversation,
      'How many people live there?',
      'Canberra is a relatively small city, with a population of around 415,000 people. However, the metropolitan area is larger.\n\nIt is also the seat of government.',
      70,
      60,
    );

    assert.strictEqual(conversation.view(), [
      'The conversation holds 2 of up to 10 exchanges.',
      '',
      '1. You: What is the capital of Australia?',
      '   The capital of Australia is Canberra.',
      '',
      '2. You: How many people live there?',
      '   Canberra is a relatively small city, with a population of around 415,000 people. However, the...',
    ].join('\n'));
  });

  it('shows only the exchanges still kept, and names a limit of one exchange in the singular', () => {
    const conversation = createConversation({ limit: 1, contextLength: 4096 });

    exchange(conversation, 'One?', 'One.', 20, 2);
    exchange(conversation, 'Two?', 'Two.', 30, 2);

    assert.strictEqual(conversation.view(), ['The conversation holds 1 of up to 1 exchange.', '', '1. You: Two?', '   Two.'].join('\n'));
  });

  it('cuts a first line longer than 100 characters at the last space within 100, and adds three dots', () => {
    const words = 'word '.repeat(30).trim();

    assert.strictEqual(firstLine(words), `${'word '.repeat(20).trim()}...`);
    assert.strictEqual(firstLine('a'.repeat(100)), 'a'.repeat(100));
    assert.strictEqual(firstLine(`${'a'.repeat(100)} b`), `${'a'.repeat(100)}...`);
    assert.strictEqual(firstLine(`${'a'.repeat(99)} bc`), `${'a'.repeat(99)}...`);
    assert.strictEqual(firstLine('a'.repeat(150)), `${'a'.repeat(100)}...`);
    assert.strictEqual(firstLine('\n\n  The first line.\nThe second line.'), 'The first line.');
  });
});

describe('clearing', () => {
  it('removes every exchange, so the next request carries the system message and the new question only', () => {
    const conversation = createConversation({ limit: 10, contextLength: 4096 });

    exchange(conversation, 'One?', 'One.', 20, 2);
    exchange(conversation, 'Two?', 'Two.', 30, 2);
    conversation.clear();

    assert.strictEqual(conversation.view(), 'The conversation is empty.');
    assert.strictEqual(conversation.size, 0);

    const next = conversation.request('Three?');
    assert.deepStrictEqual(next.messages, [
      { role: 'system', content: SYSTEM_MESSAGE },
      { role: 'user', content: 'Three?' },
    ]);
    assert.strictEqual(next.sentTokens, 0);
  });
});
