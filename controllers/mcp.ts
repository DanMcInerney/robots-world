import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RobotTools } from './tools.ts';

export function createRobotMcp(tools: RobotTools): McpServer {
  const server = new McpServer({ name: 'robots-world', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await tools.call(request.params.name, request.params.arguments)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
  });
  return server;
}

/** An authenticated loopback transport; world authority stays inside the supplied ports. */
export async function serveRobotMcp(tools: RobotTools): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex'), credential = Buffer.from(`Bearer ${token}`);
  const active = new Set<McpServer>();
  const http = createServer((req, res) => { void (async () => {
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin || auth.length !== credential.length || !timingSafeEqual(auth, credential)) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (active.size >= 16) { res.writeHead(429).end(); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const server = createRobotMcp(tools); active.add(server);
    res.once('close', () => { active.delete(server); void server.close(); });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport); await transport.handleRequest(req, res, body);
  })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }); });
  http.requestTimeout = 15000; http.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); }); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No MCP address.');
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, async close() { for (const server of active) await server.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
