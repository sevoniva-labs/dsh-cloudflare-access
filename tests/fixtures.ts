import { Context, type Fiber } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import type { Deployment } from '../src/model.ts';
export const deployment: Deployment = {
  accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), hostname: 'harness.example.com', emails: ['owner@example.com'],
  identityProvider: 'otp', postureChecks: [], authDomain: 'test-team.cloudflareaccess.com', zoneName: 'example.com', gatewayPort: 0, audience: 'test-audience',
};
export async function nativeHarness() {
  const ctx = new Context(), fibers: Fiber[] = [], records = new Map(), values = new Map<string, string>();
  const credentials = ctx.plugin((sub: Context) => {
    sub.provide('credentials', {
      modifyRecord: async (key: string, mutate: (value: unknown) => Promise<unknown>) => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); },
      resolve: async (key: string) => values.has(key) ? { value: values.get(key), source: 'test' } : undefined,
      set: async (key: string, value: string) => { values.set(key, value); }, unset: async (key: string) => { values.delete(key); },
    });
  }); fibers.push(credentials); await credentials.await();
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); fibers.push(web); await web.await();
  const connection = ctx.plugin(Connection); fibers.push(connection); await connection.await();
  const fixtures = ctx.plugin({ inject: ['webServer', 'connection'], apply(sub: Context) {
    sub.effect(() => sub.webServer.registerFallback((req, res) => { if (sub.connection.authorizeIndex(req, res)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>Native Harness fixture</body></html>'); } }));
    sub.effect(() => sub.connection.rpc.intercept('/api', endpoint => endpoint === 'llm/listProviders', async () => ({ ok: true, value: [{ id: 'fixture-provider' }] })));
    sub.effect(() => sub.connection.fetch.register({ path: '/api/echo', methods: ['POST'], requestBody: 'buffered', fetch: async request => Response.json({ body: await request.json(), host: request.headers.get('host'), origin: request.headers.get('origin'), cookie: !!request.headers.get('cookie'), cf: request.headers.get('cf-access-jwt-assertion') }) }));
  } }); fibers.push(fixtures); await fixtures.await();
  return { ctx, fibers, port: ctx.get('webServer')!.port, connection: ctx.get('connection')!, close: async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); } };
}
