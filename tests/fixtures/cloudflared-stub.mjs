#!/usr/bin/env node
// Isolated process fixture: no Cloudflare requests, secrets, or model calls.
import { open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
if (process.argv.includes('--version')) {
  process.stdout.write('cloudflared version 2026.9.1 (test fixture)\n');
} else {
  const index = process.argv.indexOf('--token-file');
  if (index < 0 || !process.argv[index + 1]) throw new Error('fixture requires its temporary token-file path');
  const directory = dirname(process.argv[index + 1]);
  try {
    const first = await open(join(directory, 'first-attempt'), 'wx'); await first.close();
    process.exitCode = 1;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await writeFile(join(directory, 'fixture.pid'), String(process.pid));
    process.stderr.write('Registered tunnel connection (test fixture)\n');
    setInterval(() => {}, 1000);
  }
}
