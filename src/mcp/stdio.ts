// matrix-memory stdio entrypoint — for Claude Code sessions (`claude mcp add`).
// owner: the owner/Sky-Lynx · sink: store/matrix.db + stderr · kill: process exit; dim guard in vec.ts

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from '../db/open.js';
import { initVec } from '../db/vec.js';
import { realEmbedder, withContextFallback } from '../embed/embedder.js';
import { createMemoryServer } from './server.js';

const db = openDb();
initVec(db);
const server = createMemoryServer(db, withContextFallback(realEmbedder));
await server.connect(new StdioServerTransport());
