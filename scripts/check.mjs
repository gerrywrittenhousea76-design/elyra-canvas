import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const mode = process.argv[2];
const args = mode === 'unit'
  ? ['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot']
  : mode === 'server'
    ? ['--test', ...readdirSync('server').filter(name => name.endsWith('.test.mjs')).map(name => `server/${name}`)]
    : null;
if (!args) throw new Error('Unknown local check');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG };
const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
