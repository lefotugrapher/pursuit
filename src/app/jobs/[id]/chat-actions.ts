'use server';

import { revalidatePath } from 'next/cache';
import { jobChatReply, type JobChatTurn } from '@/engine/jobchat';

export async function sendJobChat(jobId: string, message: string): Promise<{ turns: JobChatTurn[]; error?: string }> {
  try {
    const turns = await jobChatReply(String(jobId), String(message ?? ''));
    revalidatePath(`/jobs/${jobId}`);
    return { turns };
  } catch (err) {
    return { turns: [], error: (err as Error).message };
  }
}
