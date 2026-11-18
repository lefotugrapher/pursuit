import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { LiveStatusProvider } from '@/components/shell/LiveStatus';
import { getShellData } from '@/lib/server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#5b5bf6"/>' +
  '<path d="M11 21 21 11M13 11h8v8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const metadata: Metadata = {
  title: { default: 'Pursuit', template: '%s · Pursuit' },
  description: 'Local job-search engine: discover, tailor, approve, apply.',
  robots: { index: false, follow: false },
  // Inline app mark, so the browser never asks for a missing /favicon.ico.
  icons: { icon: `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}` },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0f' },
    { media: '(prefers-color-scheme: light)', color: '#f7f7f9' },
  ],
};

// Shell-wide motion. Kept here (not globals.css, which is shared) and referenced via Tailwind
// arbitrary animations, e.g. animate-[card-in_220ms_ease-out].
const MOTION_CSS = `
@keyframes card-in { from { opacity: 0; transform: translateX(28px) } to { opacity: 1; transform: none } }
@keyframes card-in-back { from { opacity: 0; transform: translateX(-28px) } to { opacity: 1; transform: none } }
@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes pop-in { from { opacity: 0; transform: translateY(-6px) scale(0.985) } to { opacity: 1; transform: none } }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes drawer-in { from { transform: translateX(-100%) } to { transform: none } }
@keyframes shimmer { 0% { background-position: -400px 0 } 100% { background-position: 400px 0 } }
.skeleton { background: linear-gradient(90deg, var(--panel) 0px, var(--panel-hover) 120px, var(--panel) 240px); background-size: 800px 100%; animation: shimmer 1.4s linear infinite; border-radius: var(--radius-sm); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; } }
`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const shell = await getShellData();
  return (
    <html lang="en-IE" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <style href="pursuit-motion" precedence="default">{MOTION_CSS}</style>
        <LiveStatusProvider initial={shell.status}>
          <AppShell extras={{ inbox: shell.inboxUnhandled, drafts: shell.draftsPending, dbError: shell.dbError }}>{children}</AppShell>
        </LiveStatusProvider>
      </body>
    </html>
  );
}
