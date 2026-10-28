// SPDX-License-Identifier: AGPL-3.0-or-later

/// 共通ログヘルパー。console への出力と、管理パネル用のリングバッファ保持を兼ねる。

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number,
  level: LogLevel,
  message: string,
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];

const record = (level: LogLevel, args: unknown[]): void => {
  const message = args.map(a => {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  entries.push({ ts: Date.now(), level, message });
  if (entries.length > MAX_ENTRIES) entries.shift();
  const fn = level === 'log' ? console.log
    : level === 'info' ? console.info
    : level === 'warn' ? console.warn
    : console.error;
  fn(...args);
};

export const log = (...args: unknown[]): void => record('log', args);
export const info = (...args: unknown[]): void => record('info', args);
export const warn = (...args: unknown[]): void => record('warn', args);
export const error = (...args: unknown[]): void => record('error', args);

export const getLogEntries = (): LogEntry[] => [...entries];
export const clearLogEntries = (): void => { entries.length = 0; };
