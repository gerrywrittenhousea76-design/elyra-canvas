import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['server/elyra-server.mjs'], {
  stdio: 'inherit',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, PORT: '4318', ELYRA_PREVIEW_ONLY: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
