/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineConfig, type Plugin } from 'vitest/config';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Vite plugin that accepts experiment events (JSON lines) from the browser via
 * POST /__events?run=<runId> and appends them to logs/<runId>/client-events.jsonl.
 * The run id is restricted to a safe character set so it cannot escape logs/.
 */
function eventLogPlugin(): Plugin {
  const logDir = path.resolve(__dirname, '../../logs');
  return {
    name: 'moqtail-event-log',
    configureServer(server) {
      server.middlewares.use('/__events', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const run = (url.searchParams.get('run') ?? 'adhoc').replace(/[^A-Za-z0-9._-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const dir = path.join(logDir, run);
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(
            path.join(dir, 'client-events.jsonl'),
            body.endsWith('\n') ? body : body + '\n',
          );
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), tailwindcss(), eventLogPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
