'use client';
// Editable cover letter. Save (button or ⌘S) stores a new version through saveCoverLetter, which
// re-runs the truth guard + slop lint and reports problems as flags (his wording is kept as typed).

import { useEffect, useState, useTransition, type RefObject } from 'react';
import { Badge, Button, Kbd, cx } from '@/components/ui';
import { saveLetterAction } from '@/app/queue/actions';
import { toast } from '@/components/shell/client';
import type { LetterView } from './model';

const MAX_WORDS = 250;

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function LetterEditor({
  jobId, letter, textareaRef, onDirtyChange, rows = 18,
}: {
  jobId: string;
  letter: LetterView | null;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onDirtyChange?: (dirty: boolean) => void;
  rows?: number;
}) {
  const original = letter?.text ?? '';
  const [text, setText] = useState(original);
  const [flags, setFlags] = useState<string[]>(letter ? [...letter.guardProblems, ...letter.slopHits, ...letter.flags] : []);
  const [pending, start] = useTransition();
  const dirty = text !== original;

  // A new version (save, regenerate) replaces the editor contents.
  useEffect(() => {
    setText(letter?.text ?? '');
    setFlags(letter ? [...new Set([...letter.guardProblems, ...letter.slopHits, ...letter.flags])] : []);
  }, [letter]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const save = () => {
    if (!dirty || pending) return;
    start(async () => {
      const res = await saveLetterAction(jobId, text);
      if (res.ok) {
        setFlags(res.data?.flags ?? []);
        toast({ message: res.message ?? 'Letter saved', tone: res.data?.flags.length ? 'warn' : 'good', detail: res.data?.flags.slice(0, 3).join(' · ') || undefined });
      } else toast({ message: 'Could not save the letter', tone: 'bad', detail: res.error });
    });
  };

  if (!letter) {
    return <p className="text-[13px] text-faint">No cover letter yet. Regenerate it from the job page.</p>;
  }

  const words = wordCount(text);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-faint">
        <span>v{letter.version}{letter.edited ? ' · edited by you' : ''}</span>
        <span className={cx('tabular', words > MAX_WORDS && 'text-warn')}>{words}/{MAX_WORDS} words</span>
        {dirty && <Badge tone="accent">unsaved</Badge>}
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        rows={rows}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
        }}
        spellCheck
        aria-label="Cover letter"
        className="scrollbar-thin w-full resize-y rounded-[var(--radius-sm)] border border-line bg-bg-sunk/60 px-3.5 py-3 text-[13.5px] leading-[1.65] text-fg focus:border-accent focus:outline-none"
      />
      {flags.length > 0 && (
        <ul className="space-y-1 rounded-[var(--radius-sm)] border border-warn/25 bg-warn-soft px-3 py-2 text-[12px] text-warn">
          {flags.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}
      <div className="flex items-center justify-end gap-2">
        {dirty && <Button size="sm" variant="ghost" onClick={() => setText(original)} disabled={pending}>Revert</Button>}
        <Button size="sm" variant="primary" onClick={save} disabled={!dirty || pending}>
          {pending ? 'Saving…' : 'Save letter'} <span className="hidden opacity-70 md:inline"><Kbd>⌘S</Kbd></span>
        </Button>
      </div>
    </div>
  );
}
