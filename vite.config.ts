import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { isPrivateResource } from './server/private-files.mjs';

export default defineConfig({
  plugins: [react(), { name: 'elyra-private-runtime', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (isPrivateResource((request as { url?: string }).url)) { response.writeHead(404).end(); return; }
      next();
    });
  } }],
  server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.elyra-runtime/**', '**/.proofharness/**'] }, host: '127.0.0.1', strictPort: true, port: 4175, watch: { ignored: ['**/.proofharness/**', '**/.elyra-harness/**', '**/.recovery/**', '**/.elyra-runtime/**', '**/docs/**'] } },
  preview: { host: '127.0.0.1', strictPort: true, port: 4175 },
});
