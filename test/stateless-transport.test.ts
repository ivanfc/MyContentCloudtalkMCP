import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
const { legacyFetch } = vi.hoisted(() => ({ legacyFetch: vi.fn(async () => new Response(null, { status: 204 })) }));
vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: legacyFetch }; } static serveSSE() { return {}; } } }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {}, getOAuthApi: () => ({}) }));
import { handleMcpRequest, CloudTalkTools } from '../src/index';
import type { Props } from '../src/auth/handler';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const env = { PUBLIC_BASE_URL: 'https://mcp.example.test', COOKIE_ENCRYPTION_KEY: 'test-secret', ALLOWED_EMAILS: '*' } as unknown as Env;
const props = (email: string): Props => ({ email, name: 'Test', sub: email, cloudtalk: { keyId: "fake-key-id", secret: "fake-test-secret", registeredAt: "2026-10-20" } });
const context = (email = 'a@example.test') => ({ props: props(email), waitUntil: vi.fn() }) as unknown as ExecutionContext;
const request = (method: string, params?: unknown) => new Request('https://mcp.example.test/mcp', {
 method: 'POST', headers: { host: 'mcp.example.test', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
 body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
});
async function rpc(method: string, params?: unknown, email?: string) {
 const response = await handleMcpRequest(request(method, params), env, context(email));
 const body = await response.text();
 const json = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split('\n').find(l => l.startsWith('data: '))!.slice(6)) : JSON.parse(body);
 return { response, json };
}

describe('stateless MCP HTTP transport', () => {
 it('accepts a legacy initialize without issuing a protocol session', async () => {
  const { response, json } = await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
  expect(response.status, JSON.stringify(json)).toBe(200); expect(response.headers.has('mcp-session-id')).toBe(false);
  expect(json.result.serverInfo).toMatchObject({ name: 'MyContent CloudTalk MCP', version: '0.1.0' });
 });
 it('lists all tools and executes independent calls without prior session storage', async () => {
  const listing = await rpc('tools/list'); expect(listing.response.status, JSON.stringify(listing.json)).toBe(200); expect(listing.json.result.tools).toHaveLength(23);
  const ops = ['contacts_add', 'dialer_patch_campaign'];
  const results = await Promise.all(['a@example.test', 'b@example.test'].map((email, i) => rpc('tools/call', { name: 'describe_api_operation', arguments: { operation: ops[i] } }, email)));
  for (const [i, result] of results.entries()) {
   expect(result.response.status).toBe(200); expect(result.response.headers.has('mcp-session-id')).toBe(false);
   expect(result.json.result.isError).not.toBe(true); expect(JSON.stringify(result.json.result)).toContain(ops[i]);
  }
 });
 it('continues routing existing session IDs to their legacy agent', async () => {
  const old = new Request(request('tools/list'), { headers: { ...Object.fromEntries(request('tools/list').headers), 'mcp-session-id': 'existing-session' } });
  expect((await handleMcpRequest(old, env, context())).status).toBe(204); expect(legacyFetch).toHaveBeenCalled();
 });
 it('rejects requests with a forged host or untrusted browser origin', async () => {
  const invalidHeaders: Record<string, string>[] = [{ host: 'attacker.example.test' }, { origin: 'https://attacker.example.test' }];
  for (const extra of invalidHeaders) {
   const original = request('tools/list'); const invalid = new Request(original, { headers: { ...Object.fromEntries(original.headers), ...extra } });
   expect((await handleMcpRequest(invalid, env, context())).status).toBe(403);
  }
 });
 it('never reuses a user hash after authenticated props change', async () => {
  let current = props('a@example.test'); const service = new CloudTalkTools(env, () => current);
  const userKey = () => (service as unknown as { userKey(): Promise<string> }).userKey();
  const first = await userKey(); current = props('b@example.test'); const second = await userKey();
  expect(second).not.toBe(first); current = props('A@example.test'); expect(await userKey()).toBe(first);
 });
});
