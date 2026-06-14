// Small representative Claude Code JSONL fixture for tests.
// Covers: user string-content, user list-content, assistant text, assistant
// pure-thinking/tool_use (skip), non-turn event (skip), malformed (skip+count),
// multi-text-block (concatenation), null content (skip), missing message (skip).
// NO real transcript is ever read by tests (C-22 read-only; keystone runs on this fixture).

/** Lines that SHOULD normalize into turns. */
export const TURN_LINES = {
  // user, plain string content -> 1 turn (C-14)
  userString: JSON.stringify({
    type: 'user',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:00:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-user-1',
    message: { role: 'user', content: 'hello matrix' },
  }),

  // user, list content with a text block + a tool_result(string) block (C-14)
  userList: JSON.stringify({
    type: 'user',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:01:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-user-2',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'here is the result:' },
        { type: 'tool_result', content: 'exit 0' },
      ],
    },
  }),

  // assistant, list content single text block (C-15)
  assistantText: JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:02:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-asst-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done.' }] },
  }),

  // assistant, MULTIPLE text blocks -> must concatenate ALL (C-26)
  assistantMultiText: JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:03:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-asst-2',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal reasoning that is NOT content' },
        { type: 'text', text: 'first part ' },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'text', text: 'second part' },
      ],
    },
  }),
} as const;

/** The two text fragments that assistantMultiText must concatenate (C-26). */
export const MULTI_TEXT_EXPECTED = 'first part second part';

/** Lines that SHOULD be skipped (each with the reason / claim id). */
export const SKIP_LINES = {
  // assistant pure tool_use (no text) -> non-text skip (C-16)
  assistantPureToolUse: JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:04:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-asst-3',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
  }),

  // assistant pure thinking (no text block) -> non-text skip (C-16)
  assistantPureThinking: JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:05:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-asst-4',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'just thinking' }] },
  }),

  // non-turn event type -> skip (C-13)
  nonTurnEvent: JSON.stringify({
    type: 'file-history-snapshot',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:06:00.000Z',
    snapshot: { files: [] },
  }),

  // queue-operation (seen in real data) -> skip (C-13)
  queueOperation: JSON.stringify({
    type: 'queue-operation',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:07:00.000Z',
    operation: 'enqueue',
  }),

  // malformed JSON -> skip + count, no crash (C-24)
  malformed: '{ this is not valid json ',

  // empty / whitespace line -> skip + count (C-27)
  empty: '   ',

  // user/assistant-shaped but missing message key -> skip (C-28)
  missingMessage: JSON.stringify({
    type: 'user',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:08:00.000Z',
    uuid: 'uuid-user-nomsg',
  }),

  // message.content == null -> skip (C-29)
  nullContent: JSON.stringify({
    type: 'user',
    sessionId: 'sess-A',
    timestamp: '2026-06-13T10:09:00.000Z',
    cwd: '/opt/matrix',
    gitBranch: 'main',
    uuid: 'uuid-user-null',
    message: { role: 'user', content: null },
  }),
} as const;

/** Count of lines in the fixture that should become turns. */
export const EXPECTED_TURN_COUNT = Object.keys(TURN_LINES).length; // 4

/** The full fixture as a single JSONL string (turns + skips, in mixed order). */
export const FIXTURE_JSONL: string = [
  TURN_LINES.userString,
  SKIP_LINES.nonTurnEvent,
  TURN_LINES.userList,
  SKIP_LINES.malformed,
  TURN_LINES.assistantText,
  SKIP_LINES.assistantPureToolUse,
  TURN_LINES.assistantMultiText,
  SKIP_LINES.empty,
  SKIP_LINES.queueOperation,
  SKIP_LINES.assistantPureThinking,
  SKIP_LINES.missingMessage,
  SKIP_LINES.nullContent,
].join('\n');

/** Project dir name used for the fixture (C-17). */
export const FIXTURE_PROJECT = '-home-user-projects-matrix';
