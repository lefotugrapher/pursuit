'use client';
// Opens a visible Chrome window with the form pre-filled and leaves it for Kayzee. Never submits.

import { useTransition } from 'react';
import { Button } from '@/components/ui';
import { handOffAction } from '@/app/jobs/actions';
import { toast } from '@/components/shell/client';
import { Icon } from '@/components/shell/icons';

export function HandoffButton({ jobId, label = 'Open handoff', size = 'sm', variant = 'secondary' }: {
  jobId: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'primary';
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      size={size}
      variant={variant}
      disabled={pending}
      title="Opens the form in a separate Chrome window, filled in as far as Pursuit can. You review and submit."
      onClick={() =>
        start(async () => {
          toast({ message: 'Opening Chrome…', detail: 'The form is filled but never submitted for you.', durationMs: 3000 });
          const res = await handOffAction(jobId);
          if (res.ok) toast({ message: res.message ?? 'Handed off', tone: 'good', detail: res.warnings?.slice(0, 3).join(' · ') });
          else toast({ message: 'Handoff failed', tone: 'bad', detail: res.error });
        })
      }
    >
      <Icon name="hand" size={13} /> {pending ? 'Opening…' : label}
    </Button>
  );
}
