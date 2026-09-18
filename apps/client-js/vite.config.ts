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
 * Vite plugin that accepts metrics from the browser via POST /__metrics
 * and appends them to a CSV log file in the project's logs/ directory.
 */
function metricsLogPlugin(): Plugin {
  const logDir = path.resolve(__dirname, '../../logs');
  let logPath: string | null = null;
  let headerWritten = false;

  return {
    name: 'moqtail-metrics-log',
    configureServer(server) {
      server.middlewares.use('/__metrics', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          if (!logPath) {
            fs.mkdirSync(logDir, { recursive: true });
            const ts = new Date()
              .toISOString()
              .replace(/[:.]/g, '-')
              .replace('T', '_')
              .slice(0, 19);
            logPath = path.join(logDir, `client-metrics_${ts}.csv`);
          }

          if (!headerWritten) {
            const header = body.split('\n')[0];
            if (header) {
              fs.appendFileSync(logPath, header + '\n');
              headerWritten = true;
            }
          }

          // Append data lines (skip header if present)
          const lines = body.split('\n');
          const dataLines = lines.slice(headerWritten ? 1 : 0).filter(l => l.length > 0);
          if (dataLines.length > 0) {
            fs.appendFileSync(logPath, dataLines.join('\n') + '\n');
          }

          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), tailwindcss(), metricsLogPlugin()],
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
