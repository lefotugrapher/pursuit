'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';

/**
 * Copies text to the clipboard. With `sourceId`, copies the current value of that textarea/input
 * (so edits are included); otherwise copies `text`.
 */
export function CopyButton({ text, sourceId, label = 'Copy', size = 'sm', variant = 'secondary' }: {
  text?: string; sourceId?: string; label?: string; size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    const el = sourceId ? (document.getElementById(sourceId) as HTMLTextAreaElement | HTMLInputElement | null) : null;
    const value = el?.value ?? text ?? '';
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Clipboard API can be unavailable (non-secure context): fall back to selecting the text.
      if (el) {
        el.focus();
        el.select();
        setState(document.execCommand?.('copy') ? 'copied' : 'failed');
      } else setState('failed');
    }
    window.setTimeout(() => setState('idle'), 1800);
  }

  return (
    <Button type="button" size={size} variant={variant} onClick={copy} aria-live="polite">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}
