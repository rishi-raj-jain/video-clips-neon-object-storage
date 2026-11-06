import { sql } from '@/lib/db';
import { userId } from '@/lib/user';

// One job's chat with the agent, in order: the brief, each tool call with its state,
// and the agent's reply. The clipper function writes these rows while the agent works,
// so polling this route shows the job live.
export async function GET(_request: Request, ctx: RouteContext<'/api/chats/[id]'>) {
  const { id } = await ctx.params;
  const [job] = await sql`SELECT status FROM jobs WHERE id = ${id} AND user_id = ${await userId()}`;
  if (!job) return Response.json({ error: 'No such chat.' }, { status: 404 });
  const messages = await sql`SELECT id, role, content, tool, state, created_at FROM chat_messages WHERE job_id = ${id} ORDER BY id`;
  return Response.json({ status: job.status, messages });
}
