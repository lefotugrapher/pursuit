// Sidebar + command palette navigation model. Pure.
import type { IconName } from './icons';

export type NavCountKey = 'queue' | 'needsYou' | 'inbox' | 'drafts' | 'interviews';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  count?: NavCountKey;
  /** Count shown as an attention badge (accent) rather than a quiet number. */
  emphasis?: boolean;
  keywords?: string;
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Today', icon: 'today', count: 'needsYou', keywords: 'home dashboard overview' },
  { href: '/queue', label: 'Queue', icon: 'queue', count: 'queue', emphasis: true, keywords: 'approve review ready' },
  { href: '/jobs', label: 'Jobs', icon: 'jobs', keywords: 'all list table search' },
  { href: '/pipeline', label: 'Pipeline', icon: 'pipeline', keywords: 'kanban board status' },
  { href: '/inbox', label: 'Inbox', icon: 'inbox', count: 'inbox', keywords: 'email replies gmail' },
  { href: '/outreach', label: 'Outreach', icon: 'outreach', count: 'drafts', keywords: 'contacts drafts linkedin email' },
  { href: '/interviews', label: 'Interviews', icon: 'interviews', count: 'interviews', keywords: 'prep calendar' },
  { href: '/about', label: 'About me', icon: 'about', keywords: 'facts questions evidence documents upload skills experience profile' },
  { href: '/coach', label: 'Coach', icon: 'coach', keywords: 'ai chat assistant cv improve questions facts' },
  { href: '/analytics', label: 'Analytics', icon: 'analytics', keywords: 'stats funnel response rate spend' },
  { href: '/sources', label: 'Sources', icon: 'sources', keywords: 'watchlist companies boards discovery' },
  { href: '/settings', label: 'Settings', icon: 'settings', keywords: 'profile facts answers caps mode env' },
];

export function isActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Tasks the palette can run via POST /api/task/<name> (validated server-side against TASKS). */
export const PALETTE_TASKS: { name: string; label: string; hint: string }[] = [
  { name: 'discover', label: 'Run discovery now', hint: 'Fetch new postings from every source' },
  { name: 'score', label: 'Score new jobs', hint: 'Filter + score discovered jobs' },
  { name: 'tailor', label: 'Tailor next batch', hint: 'CV, letter and answers for top scored jobs' },
  { name: 'inbox', label: 'Check inbox', hint: 'Classify new Gmail replies' },
];
