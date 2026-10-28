// SPDX-License-Identifier: AGPL-3.0-or-later

/// LAN 向けの読み取り専用管理パネル (Node 組み込み http)。

import http from 'node:http';
import fs from 'node:fs';
import { config, get } from '../config.ts';
import { getLogEntries, log } from '../log.ts';
import { getAIStatus } from '../ai/mod.ts';
import { getAllPrefs } from '../ai/prefs.ts';
import { getAnkas } from '../anka.ts';
import { getSyncPairs } from '../fluxsync/mod.ts';

const PORT = get(config, 'admin.port', 8080);
const TOKEN = get(config, 'admin.token', null);

const UI = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

const send = (res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
};

const json = (res: http.ServerResponse, status: number, data: unknown): void =>
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');

const authorized = (req: http.IncomingMessage): boolean => {
  if (!TOKEN) return true;
  const h = req.headers['authorization'] ?? '';
  return h === `Bearer ${TOKEN}`;
};

export const setupAdmin = (): void => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/index.html') {
      send(res, 200, UI, 'text/html; charset=utf-8');
      return;
    }
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    if (url === '/api/status') {
      json(res, 200, { ...getAIStatus(), ankas: getAnkas() });
      return;
    }
    if (url === '/api/sync') {
      json(res, 200, getSyncPairs());
      return;
    }
    if (url === '/api/ai-prefs') {
      json(res, 200, getAllPrefs());
      return;
    }
    if (url === '/api/logs') {
      json(res, 200, getLogEntries());
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  server.listen(PORT, () => {
    log(`admin panel listening on http://0.0.0.0:${PORT}/`);
  });
};
