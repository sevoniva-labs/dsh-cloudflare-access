import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'sevoniva-labs/dsh-cloudflare-access';
interface Analysis {
  commit_sha: string; ref: string; category: string; error: string; rules_count: number;
  tool: { name: string };
}

export function verifyCodeScanning(analyses: Analysis[], alerts: unknown[], sha: string, mainSha: string): void {
  assert.match(sha, /^[a-f0-9]{40}$/, 'Invalid release commit');
  assert.equal(mainSha, sha, 'Release commit must be the current main head; do not reuse newer-main alert dispositions');
  assert.ok(Array.isArray(analyses) && Array.isArray(alerts), 'Invalid code-scanning response');
  for (const language of ['javascript-typescript', 'actions']) {
    // GitHub returns newest analyses first. A failed rerun must not fall back
    // to an earlier successful analysis of the same commit.
    const analysis = analyses.find(item => item.commit_sha === sha && item.ref === 'refs/heads/main' && item.tool?.name === 'CodeQL' && item.category === `/language:${language}`);
    assert.ok(analysis, `Missing CodeQL ${language} analysis for release commit; wait for main scans and retry`);
    assert.equal(analysis.error, '', `CodeQL ${language} analysis failed`);
    assert.ok(Number.isInteger(analysis.rules_count) && analysis.rules_count > 0, `CodeQL ${language} ran no rules`);
  }
  assert.equal(alerts.length, 0, 'Resolve open code-scanning alerts before publishing');
}

async function gate(): Promise<void> {
  assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Unexpected repository');
  const sha = process.env.GITHUB_SHA ?? '';
  assert.match(sha, /^[a-f0-9]{40}$/, 'Invalid release commit');
  assert.ok(process.env.GH_TOKEN, 'GH_TOKEN is required');
  const read = async (endpoint: string) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store',
    });
    assert.ok(response.ok, `Code-scanning lookup failed: HTTP ${response.status}`);
    return response.json();
  };
  const main = await read('commits/main');
  assert.equal(main.sha, sha, 'Release commit must be the current main head');
  const [analyses, alerts] = await Promise.all([
    read('code-scanning/analyses?ref=refs%2Fheads%2Fmain&tool_name=CodeQL&per_page=100'),
    read('code-scanning/alerts?ref=refs%2Fheads%2Fmain&state=open&per_page=1'),
  ]);
  const confirmedMain = await read('commits/main');
  verifyCodeScanning(analyses, alerts, sha, confirmedMain.sha);
  console.log(`CodeQL JavaScript/TypeScript and Actions passed for ${sha}; no open alerts on main.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await gate();
