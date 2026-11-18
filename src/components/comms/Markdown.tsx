// Renders parsed markdown as React elements. All text goes through React's escaping; no
// dangerouslySetInnerHTML anywhere, so generated or untrusted text can never inject markup.
import type { ReactNode } from 'react';
import { cx } from '@/components/ui';
import { parseMarkdown, type Inline } from './md-parse';

function renderInline(nodes: Inline[], keyPrefix = 'i'): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (n.type) {
      case 'text': return n.text;
      case 'strong': return <strong key={key} className="font-semibold text-fg">{renderInline(n.children, key)}</strong>;
      case 'em': return <em key={key}>{renderInline(n.children, key)}</em>;
      case 'code': return <code key={key} className="rounded bg-bg-sunk px-1 py-0.5 font-mono text-[12px]">{n.text}</code>;
    }
  });
}

const HEADING_CLASS = {
  1: 'mt-6 mb-2 text-[17px] font-semibold text-fg first:mt-0',
  2: 'mt-5 mb-2 text-[15px] font-semibold text-fg first:mt-0',
  3: 'mt-4 mb-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-dim first:mt-0',
} as const;

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cx('text-[13.5px] leading-relaxed text-fg', className)}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const Tag = (`h${b.level + 1}` as 'h2' | 'h3' | 'h4');
            return <Tag key={i} className={HEADING_CLASS[b.level]}>{renderInline(b.content, `h${i}`)}</Tag>;
          }
          case 'paragraph':
            return <p key={i} className="my-2 text-dim">{renderInline(b.content, `p${i}`)}</p>;
          case 'list': {
            const List = b.ordered ? 'ol' : 'ul';
            return (
              <List key={i} className={cx('my-2 space-y-1 pl-5 text-dim', b.ordered ? 'list-decimal' : 'list-disc')}>
                {b.items.map((item, j) => <li key={j} className="pl-1 marker:text-faint">{renderInline(item, `l${i}-${j}`)}</li>)}
              </List>
            );
          }
          case 'rule':
            return <hr key={i} className="my-4 border-line" />;
        }
      })}
    </div>
  );
}
