// Tests for the claude.ai + Claude Desktop export connector.
//
// Hermetic: synthetic conversations matching the real export shape (chat_messages
// with content[] text blocks + flat text fallback, human/assistant senders, empty).
// In-memory warehouse; the real conversations.json is verified separately.

import { describe, it, expect } from 'vitest';
import { openDb } from '../db/open.js';
import {
  extractClaudeText,
  normalizeMessage,
  ingestClaudeConversations,
  toMemoryTurns,
  toDesignTurns,
  type ClaudeConversation,
  type DesignChat,
} from './claude-ai.js';

const conv: ClaudeConversation = {
  uuid: 'conv-1',
  name: 'SQL help',
  summary: 'a chat',
  created_at: '2024-08-10T00:50:00Z',
  chat_messages: [
    {
      uuid: 'm1',
      sender: 'human',
      created_at: '2024-08-10T00:50:05Z',
      text: 'flat fallback',
      content: [{ type: 'text', text: 'Help with this error' }],
    },
    {
      uuid: 'm2',
      sender: 'assistant',
      created_at: '2024-08-10T00:50:10Z',
      text: '',
      content: [
        { type: 'text', text: 'Sure. ' },
        { type: 'text', text: 'Try this.' },
      ],
    },
    {
      uuid: 'm3',
      sender: 'human',
      created_at: '2024-08-10T00:51:00Z',
      text: 'only flat text here',
      content: [],
    }, // uses flat text fallback
    {
      uuid: 'm4',
      sender: 'assistant',
      created_at: '2024-08-10T00:51:05Z',
      text: '',
      content: [{ type: 'tool_use', text: 'n/a' }],
    }, // skip: no text-type block, empty flat text
  ],
};

describe('extractClaudeText', () => {
  it('concatenates text blocks and falls back to flat text', () => {
    expect(
      extractClaudeText(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        'x',
      ),
    ).toBe('ab');
    expect(extractClaudeText([], 'fallback')).toBe('fallback');
    expect(extractClaudeText([{ type: 'tool_use', text: 'no' }], '')).toBe('');
  });
});

describe('normalizeMessage', () => {
  it('maps human->user and prefers content blocks over flat text', () => {
    const t = normalizeMessage(conv.chat_messages![0], conv);
    expect(t).not.toBeNull();
    expect(t!.role).toBe('user');
    expect(t!.content).toBe('Help with this error');
    expect(t!.conversation_id).toBe('conv-1');
    expect(t!.ts).toBe('2024-08-10T00:50:05Z');
  });
  it('skips a message with no extractable text', () => {
    expect(normalizeMessage(conv.chat_messages![3], conv)).toBeNull();
  });
});

describe('toMemoryTurns', () => {
  it('emits a conversations_memory turn + one per project memory, skipping empties', () => {
    const turns = toMemoryTurns({
      conversations_memory: 'the owner builds AI systems.',
      project_memories: { 'uuid-a': 'Project A context.', 'uuid-b': '   ', 'uuid-c': 'Project C.' },
    });
    expect(turns.map((t) => t.role)).toEqual(['memory', 'memory', 'memory']);
    expect(turns[0].conversation_id).toBe('memories');
    expect(turns[0].content).toBe('the owner builds AI systems.');
    // uuid-b (whitespace) skipped; uuid-a + uuid-c kept
    expect(turns.filter((t) => t.conversation_id === 'memories:project')).toHaveLength(2);
    expect(JSON.parse(turns[1].meta).project_uuid).toBe('uuid-a');
  });
});

describe('toDesignTurns', () => {
  it('extracts the real nested content (content.content + attachments), plus defensive cases', () => {
    const chat: DesignChat = {
      uuid: 'dc-1',
      title: 'Artifact chat',
      project: 'proj-1',
      messages: [
        {
          uuid: 'd1',
          role: 'user',
          content: { role: 'user', content: 'nested user text' },
          created_at: '2025-01-01T00:00:00Z',
        },
        {
          uuid: 'd2',
          role: 'user',
          content: { role: 'user', content: '', attachments: [{ content: 'attachment body' }] },
        },
        {
          uuid: 'd3',
          role: 'assistant',
          content: { role: 'assistant', content: 'nested assistant text' },
        },
        { uuid: 'd4', role: 'assistant', content: 'plain string fallback' }, // defensive
        { uuid: 'd5', role: 'assistant', content: { content: '' } }, // skip empty
      ],
    };
    const turns = toDesignTurns(chat);
    expect(turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant', 'assistant']);
    expect(turns[0].content).toBe('nested user text');
    expect(turns[1].content).toBe('attachment body');
    expect(turns[2].content).toBe('nested assistant text');
    expect(turns[3].content).toBe('plain string fallback');
    expect(turns[0].conversation_id).toBe('dc-1');
    expect(JSON.parse(turns[0].meta).kind).toBe('design_chat');
  });
});

describe('ingestClaudeConversations', () => {
  it('inserts the produced turns and is idempotent', () => {
    const db = openDb(':memory:');
    try {
      const first = ingestClaudeConversations(db, [conv]);
      expect(first.conversations).toBe(1);
      expect(first.inserted).toBe(3); // m1, m2, m3 (m4 skipped)
      expect(first.seen).toBe(3);
      expect(first.skipped).toBe(1);

      const n = db
        .prepare("SELECT COUNT(*) c FROM conversation_turn WHERE source='claude_ai'")
        .get() as { c: number };
      expect(n.c).toBe(3);

      const second = ingestClaudeConversations(db, [conv]);
      expect(second.inserted).toBe(0);
    } finally {
      db.close();
    }
  });
});
