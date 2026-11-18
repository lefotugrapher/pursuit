// Desktop + phone notifications. macOS banner via osascript (argv, no shell) and an optional
// ntfy push when NTFY_TOPIC is set. Never throws: a failed notification must not break a task.
// PURSUIT_NOTIFY=off disables both channels (tests); the event row is still written.

import { execFile } from 'node:child_process';
import { logEvent } from '@/lib/db';
import { env } from '@/lib/env';

export type NotifyPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';
export interface NotifyOptions { url?: string; priority?: NotifyPriority; tags?: string[] }
export interface NotifyResult { mac: boolean; ntfy: boolean }

const NTFY_PRIORITY: Record<NotifyPriority, number> = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
const DEFAULT_NTFY_URL = 'https://ntfy.sh';
const TIMEOUT_MS = 8_000;

/** Makes text safe inside an AppleScript string literal. */
export function escapeAppleScript(text: string, max = 240): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, max)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function disabled(): boolean {
  return process.env.PURSUIT_NOTIFY === 'off';
}

function macNotify(title: string, body: string): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title, 120)}"`;
  return new Promise((resolve) => {
    try {
      execFile('osascript', ['-e', script], { timeout: TIMEOUT_MS }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

async function ntfyNotify(title: string, body: string, opts: NotifyOptions): Promise<boolean> {
  const topic = env.NTFY_TOPIC;
  if (!topic) return false;
  const base = (env.NTFY_URL ?? DEFAULT_NTFY_URL).replace(/\/+$/, '');
  // JSON publishing keeps non-ASCII titles intact (HTTP headers can't carry them).
  const payload: Record<string, unknown> = {
    topic,
    title: title.slice(0, 200),
    message: body.slice(0, 2000),
    priority: NTFY_PRIORITY[opts.priority ?? 'default'],
  };
  if (opts.url && /^https?:\/\//i.test(opts.url)) payload.click = opts.url;
  if (opts.tags?.length) payload.tags = opts.tags.slice(0, 5);
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/** Shows a notification on the Mac and (when configured) pushes it to the phone. */
export async function notify(title: string, body: string, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const cleanTitle = String(title ?? '').trim() || 'Pursuit';
  const cleanBody = String(body ?? '').trim();
  let result: NotifyResult = { mac: false, ntfy: false };
  try {
    if (!disabled()) {
      const [mac, ntfy] = await Promise.all([macNotify(cleanTitle, cleanBody), ntfyNotify(cleanTitle, cleanBody, opts)]);
      result = { mac, ntfy };
      // Also to his phone on Telegram (queued and batched; a no-op until the bot is set up and paired).
      try {
        // Only what matters right away (interviews, offers). Everything else is in the morning summary.
        if (opts.priority === 'high' || opts.priority === 'urgent') {
          const { notifyTelegram } = await import('@/engine/telegram/outbox');
          notifyTelegram(cleanBody ? `${cleanTitle}\n${cleanBody}` : cleanTitle, { priority: opts.priority });
        }
      } catch {
        // Telegram is optional
      }
    }
    logEvent('notify', { title: cleanTitle.slice(0, 200), body: cleanBody.slice(0, 500), url: opts.url, priority: opts.priority ?? 'default', ...result });
  } catch {
    // never let notifications break the caller
  }
  return result;
}
