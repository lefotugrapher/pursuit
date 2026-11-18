// /queue: the approval queue. Server-rendered list of 'ready' jobs (score desc), driven client-side.

import type { Metadata } from 'next';
import { QueueDeck } from '@/components/queue/QueueDeck';
import { getQueue } from '@/lib/server';

export const metadata: Metadata = { title: 'Queue' };

export default async function QueuePage() {
  const data = await getQueue();
  return <QueueDeck items={data.items} paused={data.paused} nextDiscovery={data.nextDiscovery} inFlight={data.inFlight} />;
}
