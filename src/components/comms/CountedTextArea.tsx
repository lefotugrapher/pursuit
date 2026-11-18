'use client';

import { useState, type TextareaHTMLAttributes } from 'react';
import { cx } from '@/components/ui';

/** Textarea with a live character count; turns red past `max` (the server enforces it too). */
export function CountedTextArea({ max, defaultValue, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { max: number; defaultValue?: string }) {
  const [len, setLen] = useState((defaultValue ?? '').length);
  const over = len > max;
  return (
    <div className="space-y-1">
      <textarea
        {...rest}
        defaultValue={defaultValue}
        onChange={(e) => setLen(e.currentTarget.value.length)}
        aria-invalid={over || undefined}
        className={cx(
          'min-h-24 w-full rounded-[var(--radius-sm)] border bg-bg-sunk px-2.5 py-2 text-[13px] leading-relaxed text-fg focus:outline-none',
          over ? 'border-bad focus:border-bad' : 'border-line hover:border-line-strong focus:border-accent',
          className,
        )}
      />
      <div className={cx('text-right text-[11.5px] tabular', over ? 'text-bad' : len > max * 0.9 ? 'text-warn' : 'text-faint')}>
        {len}/{max}
      </div>
    </div>
  );
}
