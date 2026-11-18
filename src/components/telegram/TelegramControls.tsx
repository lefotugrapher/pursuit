'use client';
// Buttons for the Telegram card. After a pairing code is generated it shows the exact steps and
// refreshes the page every few seconds until the bot reports the pairing (or the code expires).

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import { CopyButton } from '@/components/comms/CopyButton';
import { Button, cx } from '@/components/ui';
import { disconnectTelegramAction, generatePairingCodeAction, sendTestMessageAction } from './actions';
import type { TelegramActionState } from './state';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });

function Result({ state }: { state: TelegramActionState }) {
  if (!state || state.code) return null;
  return <p role={state.ok ? 'status' : 'alert'} className={cx('text-[12px]', state.ok ? 'text-good' : 'text-bad')}>{state.message}</p>;
}

export function TelegramControls({ paired, pinned, pairedAt, botUsername, codeExpiresAt }: {
  paired: boolean; pinned: boolean; pairedAt: string | null; botUsername: string | null; codeExpiresAt: string | null;
}) {
  const router = useRouter();
  const [code, generate, generating] = useActionState(generatePairingCodeAction, null);
  const [test, sendTest, testing] = useActionState(sendTestMessageAction, null);
  const [disc, disconnect, disconnecting] = useActionState(disconnectTelegramAction, null);

  const justPaired = Boolean(code?.code && pairedAt && code.createdAt && pairedAt >= code.createdAt);
  const waiting = Boolean(code?.code && code.expiresAt && !justPaired && Date.parse(code.expiresAt) > Date.now());

  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(t);
  }, [waiting, router]);

  const bot = code?.botUsername ?? botUsername;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!pinned && (
          <form action={generate}>
            <Button type="submit" size="sm" variant={paired ? 'secondary' : 'primary'} disabled={generating}>
              {generating ? 'Generating…' : paired ? 'Pair a different chat' : 'Generate pairing code'}
            </Button>
          </form>
        )}
        {paired && (
          <form action={sendTest}>
            <Button type="submit" size="sm" disabled={testing}>{testing ? 'Sending…' : 'Send test message'}</Button>
          </form>
        )}
        {paired && !pinned && (
          <form action={disconnect} onSubmit={(e) => { if (!window.confirm('Disconnect Telegram? The bot will ignore every chat until you pair again.')) e.preventDefault(); }}>
            <Button type="submit" size="sm" variant="ghost" disabled={disconnecting}>Disconnect</Button>
          </form>
        )}
      </div>
      <Result state={test} />
      <Result state={disc} />
      {code && !code.ok && <p role="alert" className="text-[12px] text-bad">{code.message}</p>}

      {code?.code && justPaired && <p role="status" className="text-[12.5px] text-good">Paired. Questions and updates will arrive in that chat.</p>}
      {code?.code && !justPaired && (
        <div className="space-y-2 rounded-[var(--radius-sm)] border border-line bg-bg-sunk p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[24px] font-semibold tracking-[0.2em] text-fg tabular">{code.code}</span>
            <CopyButton text={`/pair ${code.code}`} label="Copy /pair command" />
          </div>
          <ol className="list-decimal space-y-1 pl-4 text-[12.5px] text-dim">
            <li>Open Telegram on your phone.</li>
            <li>
              Search for {bot ? <a className="text-accent hover:underline" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">@{bot}</a> : 'your bot'} and press Start.
            </li>
            <li>Send <span className="font-mono text-fg">/pair {code.code}</span></li>
          </ol>
          <p className="text-[11.5px] text-faint">
            {waiting ? `Expires at ${time(code.expiresAt!)}. The worker must be running to see your message; this page updates when it does.` : codeExpiresAt ? '' : 'This code has expired: generate a new one.'}
          </p>
        </div>
      )}
    </div>
  );
}
