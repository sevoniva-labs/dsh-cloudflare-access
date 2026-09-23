import { beforeAll, expect, test } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { accessVerifier } from '../src/gateway.ts';
import { deployment } from './fixtures.ts';
let keys: Awaited<ReturnType<typeof generateKeyPair>>, jwk: JWK;
beforeAll(async () => { keys = await generateKeyPair('RS256'); jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }; });
async function token(claims: Record<string, unknown> = {}, signing = keys.privateKey) {
  return new SignJWT({ email: 'owner@example.com', type: 'app', sub: 'user', iss: `https://${deployment.authDomain}`, aud: deployment.audience, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(signing);
}
const verifier = () => accessVerifier(deployment, (async (url: unknown) => { expect(String(url)).toBe(`https://${deployment.authDomain}/cdn-cgi/access/certs`); return Response.json({ keys: [jwk] }); }) as typeof fetch);
test('verifies real RSA signature + issuer + audience + identity', async () => { expect(await verifier()(await token())).toMatchObject({ email: 'owner@example.com', subject: 'user' }); });
test.each([{ email: 'intruder@example.com' }, { iss: 'https://evil.test' }, { aud: 'other-app' }, { type: 'org' }, { exp: 1 }, { sub: '' }, { iat: 1 }])('rejects invalid claims %j', async claims => { await expect(verifier()(await token(claims))).rejects.toThrow(); });
test('rejects a forged signing key', async () => { const other = await generateKeyPair('RS256'); await expect(verifier()(await token({}, other.privateKey))).rejects.toThrow(); });
test('effective stream expiry cannot outlive the configured maximum token age', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const check = accessVerifier(deployment, async () => Response.json({ keys: [jwk] }), 3600);
  expect((await check(await token({ iat, exp: iat + 86_400 }))).expires).toBe((iat + 3600) * 1000);
  await expect(check(await token({ iat: iat - 3601, exp: iat + 3600 }))).rejects.toThrow();
});
