// Settings card: Telegram connection status, pairing, test message. Async server component; the
// buttons live in TelegramControls (client). Shows whether the token is set, never its value.

import { connection } from 'next/server';
import { KeyValue, Notice } from '@/components/settings/kit';
import { Badge, Card, timeAgo } from '@/components/ui';
import { HOURLY_LIMIT } from '@/engine/telegram/outbox';
import { telegramStatus } from '@/engine/telegram/status';
import { TelegramControls } from './TelegramControls';

export async function TelegramCard() {
  await connection();
  const s = await telegramStatus();
  const username = s.bot.username;

  if (!s.tokenSet) {
    return (
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Telegram</h3>
          <Badge>Not set up</Badge>
        </div>
        <Notice tone="neutral" title="Get questions and updates on your phone">
          <ol className="list-decimal space-y-1 pl-4">
            <li>In Telegram, open @BotFather, send /newbot and follow the steps.</li>
            <li>Copy the token it gives you into .env.local as TELEGRAM_BOT_TOKEN=...</li>
            <li>Restart the worker and the dashboard, then come back here to pair.</li>
          </ol>
        </Notice>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-fg">Telegram</h3>
        {s.paired ? <Badge tone="good">Paired</Badge> : <Badge tone="warn">Not paired</Badge>}
        {!s.tokenValid && <Badge tone="bad">Token looks wrong</Badge>}
        {s.lastPoll && !s.lastPoll.ok && <Badge tone="bad">Last check failed</Badge>}
      </div>
      <p className="text-[12.5px] text-dim">
        Pursuit texts you when an application needs an answer, remembers your reply in the answer bank, and puts the job back in the
        apply queue. It also sends updates, and takes /status, /pause and /resume. It only ever talks to the one chat you pair.
      </p>
      <KeyValue
        rows={[
          ['Bot token', 'Set (TELEGRAM_BOT_TOKEN)'],
          ['Bot', username ? <a key="bot" className="text-accent hover:underline" href={`https://t.me/${username}`} target="_blank" rel="noreferrer">@{username}</a> : <span key="bot" className="text-warn">{s.bot.error ?? 'unknown'}</span>],
          ['Paired', s.pairedVia === 'env' ? 'Yes, pinned by TELEGRAM_CHAT_ID' : s.paired ? `Yes${s.pairedAt ? `, ${timeAgo(s.pairedAt)}` : ''}` : 'No'],
          ['Last check', s.lastPoll ? `${timeAgo(s.lastPoll.at)}${s.lastPoll.ok ? '' : `: ${s.lastPoll.error ?? 'failed'}`}` : 'Never: the worker polls Telegram (pnpm worker)'],
          ['Questions', s.questionsWaiting ? `${s.questionsWaiting} waiting for your answer` : 'None waiting'],
          ['Messages', `${s.budget.sentLastHour} sent in the last hour (limit ${HOURLY_LIMIT})${s.outboxPending ? `, ${s.outboxPending} queued` : ''}`],
          ...(s.ignored.count ? [['Ignored', `${s.ignored.count} message${s.ignored.count === 1 ? '' : 's'} from other chats`] as [string, string]] : []),
        ]}
      />
      <TelegramControls
        paired={s.paired}
        pinned={s.pairedVia === 'env'}
        pairedAt={s.pairedAt ?? null}
        botUsername={username ?? null}
        codeExpiresAt={s.code?.expiresAt ?? null}
      />
    </Card>
  );
}

export default TelegramCard;
