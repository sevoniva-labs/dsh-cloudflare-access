import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authDomain, fail, validateSetup, type State } from './model.ts';

/** Atomic private state: never contains the management API token or tunnel token. */
export class StateStore {
  state: State = { version: 1, installationId: randomUUID(), enabled: false, phase: 'unconfigured' };
  constructor(readonly directory: string) {}
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) as State;
      if (value.version !== 1 || typeof value.installationId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.installationId) || typeof value.enabled !== 'boolean') throw new Error('invalid');
      if (!['unconfigured', 'provisioning', 'configured', 'error'].includes(value.phase)) throw new Error('phase');
      if (value.deployment) {
        validateSetup(value.deployment); authDomain(value.deployment.authDomain);
        if (!Number.isInteger(value.deployment.gatewayPort) || value.deployment.gatewayPort < 1024 || value.deployment.gatewayPort > 65535) throw new Error('port');
        for (const id of ['appId', 'policyId', 'tunnelId', 'dnsId'] as const) if (value.deployment[id] !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(value.deployment[id]!)) throw new Error('id');
      } else if (value.enabled || value.phase !== 'unconfigured') throw new Error('deployment');
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('STATE_INVALID', '本机状态文件损坏；已停止远程发布，请先恢复备份。');
    }
  }
  async save(): Promise<void> { await privateWrite(join(this.directory, 'state.json'), JSON.stringify(this.state, null, 2) + '\n'); }
}
export async function privateWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
