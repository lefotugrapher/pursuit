// Logging: concise console line + an events row (type `log.<level>`). Server-only.
// Set PURSUIT_LOG_SILENT=1 to silence the console (tests); events are still written.

import { logEvent, toJsonText } from './db';
import { redactSecrets } from './env';
import type { Logger } from './types';

export type LogLevel = 'info' | 'warn' | 'error';

const CONSOLE_DETAIL_MAX = 300;

function consoleDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` (${detail.message})`;
  if (typeof detail === 'string') return ` ${redactSecrets(detail).slice(0, CONSOLE_DETAIL_MAX)}`;
  const text = toJsonText(detail);
  return ` ${text.length > CONSOLE_DETAIL_MAX ? `${text.slice(0, CONSOLE_DETAIL_MAX)}…` : text}`;
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Keeps the stored detail JSON-friendly (Errors become {name, message, stack}). */
function storableDetail(detail: unknown): unknown {
  if (detail instanceof Error) return { name: detail.name, message: detail.message, stack: detail.stack?.split('\n').slice(0, 6).join('\n') };
  return detail;
}

function emit(level: LogLevel, scope: string, msg: string, detail?: unknown, jobId?: string): void {
  try {
    if (process.env.PURSUIT_LOG_SILENT !== '1') {
      const line = `${clock()} ${level.toUpperCase().padEnd(5)} ${scope}: ${redactSecrets(String(msg))}${consoleDetail(detail)}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    const payload: Record<string, unknown> = { scope, msg };
    if (detail !== undefined) payload.detail = storableDetail(detail);
    logEvent(`log.${level}`, payload, jobId);
  } catch {
    // A detail object whose toJSON/getters throw must not take the caller down.
  }
}

/** `log.info('discovery', 'found 12 jobs', {source: 'greenhouse'})`. Never throws. */
export const log = {
  info: (scope: string, msg: string, detail?: unknown) => emit('info', scope, msg, detail),
  warn: (scope: string, msg: string, detail?: unknown) => emit('warn', scope, msg, detail),
  error: (scope: string, msg: string, detail?: unknown) => emit('error', scope, msg, detail),
  /** Same as the level helpers, but attaches the event to a job's timeline. */
  forJob: (level: LogLevel, jobId: string, scope: string, msg: string, detail?: unknown) => emit(level, scope, msg, detail, jobId),
};

/** Scoped Logger (the contract type adapters receive in SourceContext). */
export function makeLogger(scope: string): Logger {
  return {
    info: (msg, d) => emit('info', scope, msg, d),
    warn: (msg, d) => emit('warn', scope, msg, d),
    error: (msg, d) => emit('error', scope, msg, d),
  };
}
