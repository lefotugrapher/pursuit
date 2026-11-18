import { connection } from 'next/server';
import { Board } from '@/components/pipeline/Board';
import { PageHeader } from '@/components/settings/kit';
import { LinkButton } from '@/components/ui';
import { pipelineColumns } from '@/lib/server-more';
import { moveJobAction } from './actions';

export const metadata = { title: 'Pipeline' };

export default async function PipelinePage() {
  await connection();
  const columns = pipelineColumns();
  const active = columns.filter((c) => c.name !== 'Closed').reduce((n, c) => n + c.total, 0);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Pipeline"
        description={`${active} active job${active === 1 ? '' : 's'} by stage. Use a card's menu to move it; only valid moves are offered.`}
        actions={<LinkButton href="/queue" variant="primary" size="sm">Review queue</LinkButton>}
      />
      <Board columns={columns} action={moveJobAction} />
    </div>
  );
}
