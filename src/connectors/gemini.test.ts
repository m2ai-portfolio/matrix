// Tests for the Gemini connector (Workspace per-file JSON + My-Activity fallback).
//
// Hermetic: temp files + in-memory warehouse. The Workspace fixture mirrors the
// real "Gemini in Workspace" export shape (conversation_turns with user_turn /
// system_turn) verified 2026-06-21.

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db/open.js';
import {
  normalizeWorkspaceConversation,
  normalizeRecord,
  ingestGeminiFile,
  type WorkspaceConversation,
} from './gemini.js';

const wsConv: WorkspaceConversation = {
  title: 'Convert the selected text to a table.',
  creation_time: '2026-05-17T17:58:41Z',
  conversation_turns: [
    {
      user_turn: {
        prompt: 'Convert the selected text to a table.',
        turn_index: 0,
        turn_last_modified: '2026-05-17T17:58:41Z',
      },
    },
    {
      system_turn: {
        model_thoughts: [{ headline: 'x', description: 'y' }],
        text: [{ data: "Here's the table you asked for." }],
        turn_index: 1,
        turn_last_modified: '2026-05-17T17:58:42Z',
      },
    },
    { user_turn: { prompt: '   ', turn_index: 2 } }, // skip: empty prompt
    { system_turn: { text: [], turn_index: 3 } }, // skip: no text
  ],
};

describe('normalizeWorkspaceConversation', () => {
  it('maps user_turn/system_turn to user/assistant turns and skips empties', () => {
    const turns = normalizeWorkspaceConversation(wsConv, 'conversation_123');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0].content).toBe('Convert the selected text to a table.');
    expect(turns[1].content).toBe("Here's the table you asked for.");
    expect(turns[1].ts).toBe('2026-05-17T17:58:42Z');
    expect(turns[0].conversation_id).toBe('conversation_123');
    expect(JSON.parse(turns[1].meta).has_thoughts).toBe(true);
  });
});

describe('normalizeRecord (My Activity fallback)', () => {
  it('maps a "Prompted ..." record to a user turn', () => {
    const turns = normalizeRecord(
      { header: 'Gemini Apps', title: 'Prompted How do I sort?', time: '2025-01-15T03:21:09Z' },
      0,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('How do I sort?');
  });
});

describe('ingestGeminiFile', () => {
  it('ingests a Workspace conversation file (auto-detected) and is idempotent', () => {
    const path = join(tmpdir(), `gemini-ws-${process.pid}-${Math.floor(performance.now())}.txt`);
    writeFileSync(path, JSON.stringify(wsConv));
    const db = openDb(':memory:');
    try {
      const first = ingestGeminiFile(db, path);
      expect(first.format).toBe('workspace');
      expect(first.produced).toBe(2);
      expect(first.inserted).toBe(2);

      const n = db
        .prepare("SELECT COUNT(*) c FROM conversation_turn WHERE source='gemini'")
        .get() as { c: number };
      expect(n.c).toBe(2);

      const second = ingestGeminiFile(db, path);
      expect(second.inserted).toBe(0);
    } finally {
      db.close();
    }
  });

  it('auto-detects a My-Activity array file', () => {
    const path = join(tmpdir(), `gemini-ma-${process.pid}-${Math.floor(performance.now())}.json`);
    writeFileSync(
      path,
      JSON.stringify([{ title: 'Prompted hello', time: '2025-01-01T00:00:00Z' }]),
    );
    const db = openDb(':memory:');
    try {
      const r = ingestGeminiFile(db, path);
      expect(r.format).toBe('my-activity');
      expect(r.inserted).toBe(1);
    } finally {
      db.close();
    }
  });
});
