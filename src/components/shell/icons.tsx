// Minimal stroke icon set (16px grid, currentColor). Server and client safe.
import type { SVGProps } from 'react';

export type IconName =
  | 'today' | 'queue' | 'jobs' | 'pipeline' | 'inbox' | 'outreach' | 'interviews' | 'coach' | 'analytics' | 'sources' | 'settings'
  | 'search' | 'command' | 'pause' | 'play' | 'menu' | 'close' | 'external' | 'left' | 'right' | 'check' | 'skip'
  | 'edit' | 'spark' | 'star' | 'refresh' | 'alert' | 'bolt' | 'hand' | 'file' | 'clock' | 'down';

const PATHS: Record<IconName, string> = {
  today: 'M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z',
  queue: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h6M11 11l1.5 1.5L15 10',
  jobs: 'M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1M2 5.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-6ZM2 8.5h12',
  pipeline: 'M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v4h-3z',
  inbox: 'M2 9.5 3.6 3.6A1.5 1.5 0 0 1 5 2.5h6a1.5 1.5 0 0 1 1.4 1.1L14 9.5v2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-2ZM2 9.5h3.5l1 1.5h3l1-1.5H14',
  outreach: 'M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5L14 2Z',
  interviews: 'M3 3.5h10a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1ZM2 6.5h12M5 2v3M11 2v3',
  coach: 'M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11h0A1.5 1.5 0 0 1 2.5 9.5V4ZM5.5 6.5h5M5.5 8.5h3',
  analytics: 'M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V3',
  sources: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 8l4.2-4.2',
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM13 8a5 5 0 0 0-.1-1l1.3-1-1.3-2.2-1.5.6a5 5 0 0 0-1.7-1L9.4 1.8H6.6l-.3 1.6a5 5 0 0 0-1.7 1l-1.5-.6L1.8 6l1.3 1a5 5 0 0 0 0 2l-1.3 1 1.3 2.2 1.5-.6a5 5 0 0 0 1.7 1l.3 1.6h2.8l.3-1.6a5 5 0 0 0 1.7-1l1.5.6 1.3-2.2-1.3-1c.1-.3.1-.7.1-1Z',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3.5-3.5',
  command: 'M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6Zm0 0h4m-4 0v4m4-4V4.5A1.5 1.5 0 1 1 11.5 6H10Zm0 0v4m0 0h1.5a1.5 1.5 0 1 1-1.5 1.5V10Zm0 0H6m0 0v1.5A1.5 1.5 0 1 1 4.5 10H6Z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  play: 'M4.5 3v10l8.5-5-8.5-5Z',
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  close: 'M4 4l8 8M12 4l-8 8',
  external: 'M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3',
  left: 'M10 3.5 5.5 8l4.5 4.5',
  right: 'M6 3.5 10.5 8 6 12.5',
  down: 'M3.5 6 8 10.5 12.5 6',
  check: 'M3 8.5 6.5 12 13 4.5',
  skip: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  edit: 'M10.5 2.5l3 3-8 8H2.5v-3l8-8Z',
  spark: 'M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4L8 1.5Z',
  star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8Z',
  refresh: 'M13.5 3v3.5H10M2.5 13v-3.5H6M12.8 6.5A5 5 0 0 0 3.6 5M3.2 9.5a5 5 0 0 0 9.2 1.5',
  alert: 'M8 5.5v3.5M8 11.2v.1M7.1 2.3 1.6 12a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.3a1 1 0 0 0-1.8 0Z',
  bolt: 'M9 1.5 3 9h4.5L7 14.5 13 7H8.5L9 1.5Z',
  hand: 'M5.5 8V3.5a1 1 0 0 1 2 0V7m0-3.5v-1a1 1 0 0 1 2 0V7m0-3a1 1 0 0 1 2 0v4.5a5 5 0 0 1-5 5H8a4.5 4.5 0 0 1-3.6-1.8L2.3 9.8a1 1 0 0 1 1.5-1.3L5.5 10',
  file: 'M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L9 1.5ZM9 1.5V5h3.5M5.5 8.5h5M5.5 11h5',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.5V8l2.5 1.5',
};

export function Icon({ name, size = 16, className, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
