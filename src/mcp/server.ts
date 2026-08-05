// matrix-memory MCP server wiring: three tools over the fleet-memory logic.
// Transport-agnostic; entrypoints (stdio.ts, http.ts) attach the transport.
// The warehouse is the owner's most sensitive corpus (repo CLAUDE.md): this server
// binds loopback/stdio ONLY and must never be exposed on a public tunnel without
// a redaction layer.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { Embedder } from '../embed/embedder.js';
import { search, remember, recent } from './memory.js';

export function createMemoryServer(db: Database, embedder: Embedder): McpServer {
  const server = new McpServer({ name: 'matrix-memory', version: '0.1.0' });

  server.registerTool(
    'memory_search',
    {
      title: 'Search fleet memory',
      description:
        'Semantic search over the Matrix warehouse (253k+ turns across Claude Code, CCOS, ' +
        'ChatGPT, Gemini, Claude Desktop, and fleet_memory). Returns top-k turns with source and score.',
      inputSchema: {
        query: z.string().min(1),
        k: z.number().int().min(1).max(50).optional(),
        source: z.string().optional(),
      },
    },
    async ({ query, k, source }) => {
      const hits = await search(db, query, embedder, { k, source });
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    'memory_remember',
    {
      title: 'Remember a learning',
      description:
        'Append-only write into the fleet_memory lane, embedded immediately so every other ' +
        'agent sees it on their next memory_search. Idempotent per (agent, text).',
      inputSchema: {
        agent: z.string().min(1),
        text: z.string().min(1),
        topic: z.string().optional(),
      },
    },
    async ({ agent, text, topic }) => {
      const m = await remember(db, embedder, { agent, text, topic });
      return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
    },
  );

  server.registerTool(
    'memory_recent',
    {
      title: 'Recent fleet memories',
      description: 'Newest fleet_memory entries (passive hive-mind glance), optionally per agent.',
      inputSchema: {
        n: z.number().int().min(1).max(100).optional(),
        agent: z.string().optional(),
      },
    },
    ({ n, agent }) => {
      const rows = recent(db, n ?? 20, agent);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  return server;
}
