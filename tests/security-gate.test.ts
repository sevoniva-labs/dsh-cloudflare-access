import { expect, test } from 'vitest';
import { verifyCodeScanning } from '../scripts/security-gate.ts';

const sha = 'a'.repeat(40);
const analyses = ['javascript-typescript', 'actions'].map(language => ({ commit_sha: sha, ref: 'refs/heads/main', category: `/language:${language}`, error: '', rules_count: 20, tool: { name: 'CodeQL' } }));
test('release gate requires both successful CodeQL analyses of the exact main commit', () => {
  expect(() => verifyCodeScanning(analyses, [], sha, sha)).not.toThrow();
  expect(() => verifyCodeScanning(analyses.slice(0, 1), [], sha, sha)).toThrow('Missing CodeQL actions');
  expect(() => verifyCodeScanning(analyses, [], 'b'.repeat(40), 'b'.repeat(40))).toThrow('Missing CodeQL');
  for (const change of [{ ref: 'refs/pull/1/merge' }, { tool: { name: 'Other' } }, { category: '/other:javascript-typescript' }]) {
    expect(() => verifyCodeScanning(analyses.map(item => ({ ...item, ...change })), [], sha, sha)).toThrow('Missing CodeQL');
  }
});
test('release gate fails closed on errors, empty queries, unresolved alerts and malformed responses', () => {
  for (const change of [{ error: 'failed' }, { error: undefined }, { rules_count: 0 }, { rules_count: undefined }]) {
    expect(() => verifyCodeScanning(analyses.map(item => ({ ...item, ...change })) as never, [], sha, sha)).toThrow();
  }
  expect(() => verifyCodeScanning([{ ...analyses[0]!, error: 'rerun failed' }, ...analyses], [], sha, sha)).toThrow('analysis failed');
  expect(() => verifyCodeScanning(analyses, [{ state: 'open' }], sha, sha)).toThrow('Resolve open');
  expect(() => verifyCodeScanning(null as never, [], sha, sha)).toThrow('Invalid code-scanning response');
  expect(() => verifyCodeScanning(analyses, {} as never, sha, sha)).toThrow('Invalid code-scanning response');
  expect(() => verifyCodeScanning(analyses, [], 'main', sha)).toThrow('Invalid release commit');
});
test('historical tags cannot borrow a newer main commit with resolved alerts', () => {
  expect(() => verifyCodeScanning(analyses, [], sha, 'b'.repeat(40))).toThrow('current main head');
  expect(() => verifyCodeScanning(analyses, [], sha, undefined as never)).toThrow('current main head');
});
