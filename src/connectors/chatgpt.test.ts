// Tests for the ChatGPT Tier-B export connector.
//
// Hermetic: a synthetic conversations array exercising the mapping-tree shape
// (root/null nodes, system+tool+hidden+empty skips, multimodal + code text, and
// the create_time -> ISO conversion). The warehouse is an in-memory DB so no real
// store is touched. The real conversations.json is verified separately before the
// live ingest.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db/open.js';
import {
  extractChatgptText,
  normalizeNode,
  ingestChatgptConversations,
  ingestChatgptStaging,
  isConversationsFile,
  type ChatConversation,
} from './chatgpt.js';

const CREATE = 1_700_000_000; // unix seconds

const conv: ChatConversation = {
  id: 'conv-1',
  title: 'My chat',
  create_time: CREATE,
  default_model_slug: 'gpt-4o',
  mapping: {
    root: { id: 'root', message: null, parent: null, children: ['m1'] }, // skip: null message
    m1: {
      id: 'm1',
      message: {
        id: 'm1',
        author: { role: 'user' },
        create_time: CREATE + 1,
        content: { content_type: 'text', parts: ['Hello ', 'world'] },
      },
    },
    m2: {
      id: 'm2',
      message: {
        id: 'm2',
        author: { role: 'assistant' },
        create_time: CREATE + 2,
        content: {
          content_type: 'multimodal_text',
          parts: ['Here you go', { asset_pointer: 'file://x' }],
        },
      },
    },
    sys: {
      id: 'sys',
      message: {
        id: 'sys',
        author: { role: 'system' },
        content: { content_type: 'text', parts: ['hidden context'] },
        metadata: { is_visually_hidden_from_conversation: true },
      },
    }, // skip: system + hidden
    tool: {
      id: 'tool',
      message: {
        id: 'tool',
        author: { role: 'tool' },
        content: { content_type: 'execution_output', text: 'stdout' },
      },
    }, // skip: tool role
    empty: {
      id: 'empty',
      message: {
        id: 'empty',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: [''] },
      },
    }, // skip: no text
  },
};

describe('extractChatgptText', () => {
  it('joins string parts and ignores asset objects', () => {
    expect(extractChatgptText({ content_type: 'text', parts: ['a', 'b'] })).toBe('ab');
    expect(
      extractChatgptText({ content_type: 'multimodal_text', parts: ['t', { asset_pointer: 'x' }] }),
    ).toBe('t');
  });
  it('falls back to text for code/execution content', () => {
    expect(extractChatgptText({ content_type: 'code', text: 'print(1)' })).toBe('print(1)');
  });
  it('returns empty for null/odd content', () => {
    expect(extractChatgptText(null)).toBe('');
    expect(extractChatgptText({ content_type: 'user_editable_context' })).toBe('');
  });
});

describe('normalizeNode', () => {
  it('keeps a user turn and converts create_time to ISO', () => {
    const t = normalizeNode(conv.mapping!.m1, conv);
    expect(t).not.toBeNull();
    expect(t!.role).toBe('user');
    expect(t!.content).toBe('Hello world');
    expect(t!.conversation_id).toBe('conv-1');
    expect(t!.ts).toBe(new Date((CREATE + 1) * 1000).toISOString());
  });
  it('skips null-message, system+hidden, tool, and empty nodes', () => {
    expect(normalizeNode(conv.mapping!.root, conv)).toBeNull();
    expect(normalizeNode(conv.mapping!.sys, conv)).toBeNull();
    expect(normalizeNode(conv.mapping!.tool, conv)).toBeNull();
    expect(normalizeNode(conv.mapping!.empty, conv)).toBeNull();
  });
});

describe('ingestChatgptConversations', () => {
  it('inserts only user+assistant turns and is idempotent', () => {
    const db = openDb(':memory:');
    try {
      const first = ingestChatgptConversations(db, [conv]);
      expect(first.conversations).toBe(1);
      expect(first.inserted).toBe(2); // m1 (user) + m2 (assistant)
      expect(first.seen).toBe(2);
      expect(first.skipped).toBe(4); // root + sys + tool + empty

      const rows = db
        .prepare("SELECT COUNT(*) c FROM conversation_turn WHERE source='chatgpt'")
        .get() as { c: number };
      expect(rows.c).toBe(2);

      // Second pass over identical input inserts zero.
      const second = ingestChatgptConversations(db, [conv]);
      expect(second.inserted).toBe(0);
      const rows2 = db
        .prepare("SELECT COUNT(*) c FROM conversation_turn WHERE source='chatgpt'")
        .get() as { c: number };
      expect(rows2.c).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('isConversationsFile', () => {
  it('matches the single file and numbered shards', () => {
    expect(isConversationsFile('conversations.json')).toBe(true);
    expect(isConversationsFile('conversations-000.json')).toBe(true);
    expect(isConversationsFile('conversations-9.json')).toBe(true);
  });
  it('rejects share-link metadata and other export files', () => {
    expect(isConversationsFile('shared_conversations.json')).toBe(false);
    expect(isConversationsFile('conversation_asset_file_names.json')).toBe(false);
    expect(isConversationsFile('chat.html')).toBe(false);
    expect(isConversationsFile('conversations.json.bak')).toBe(false);
  });
});

describe('ingestChatgptStaging', () => {
  it('ingests across multiple shard files and dedupes overlap', () => {
    // Two conversations split across two shards (the real export shape), plus a
    // third shard that re-contains conv A to prove cross-file content-hash dedupe.
    const convA: ChatConversation = {
      id: 'A',
      title: 'A',
      create_time: CREATE,
      mapping: {
        a1: {
          id: 'a1',
          message: {
            id: 'a1',
            author: { role: 'user' },
            create_time: CREATE,
            content: { content_type: 'text', parts: ['from A'] },
          },
        },
      },
    };
    const convB: ChatConversation = {
      id: 'B',
      title: 'B',
      create_time: CREATE,
      mapping: {
        b1: {
          id: 'b1',
          message: {
            id: 'b1',
            author: { role: 'assistant' },
            create_time: CREATE,
            content: { content_type: 'text', parts: ['from B'] },
          },
        },
      },
    };

    const dir = mkdtempSync(join(tmpdir(), 'matrix-chatgpt-'));
    const db = openDb(':memory:');
    try {
      const f0 = join(dir, 'conversations-000.json');
      const f1 = join(dir, 'conversations-001.json');
      const f2 = join(dir, 'conversations-002.json');
      writeFileSync(f0, JSON.stringify([convA]));
      writeFileSync(f1, JSON.stringify([convB]));
      writeFileSync(f2, JSON.stringify([convA])); // overlap with f0

      const r = ingestChatgptStaging(db, [f0, f1, f2]);
      expect(r.conversations).toBe(3); // 3 files processed
      expect(r.seen).toBe(3); // a1 + b1 + a1-again
      expect(r.inserted).toBe(2); // a1, b1 — the overlap is deduped

      const rows = db
        .prepare("SELECT COUNT(*) c FROM conversation_turn WHERE source='chatgpt'")
        .get() as { c: number };
      expect(rows.c).toBe(2);

      // Re-running the whole staging set inserts nothing.
      expect(ingestChatgptStaging(db, [f0, f1, f2]).inserted).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
