import { sql } from '@/lib/db';
import { createAgent, getInstance } from '@/lib/agent37';
import { userId } from '@/lib/user';

// This user's agent, if they have one, with its Agent37 status: "running" or
// "sleeping" (auto-sleep), so the page can show that an upload wakes it.
export async function GET() {
  const [row] = await sql`SELECT instance_id FROM agents WHERE user_id = ${await userId()}`;
  if (!row) return Response.json({ agent: null });
  const instance = await getInstance(row.instance_id).catch(() => null);
  return Response.json({ agent: { id: row.instance_id, status: instance?.status ?? 'unknown' } });
}

// Create the user's agent once. A second call returns the one they have.
export async function POST() {
  const uid = await userId();
  const [existing] = await sql`SELECT instance_id FROM agents WHERE user_id = ${uid}`;
  if (existing) return Response.json({ agent: { id: existing.instance_id } });
  const instance = await createAgent(uid);
  await sql`INSERT INTO agents (user_id, instance_id) VALUES (${uid}, ${instance.id}) ON CONFLICT (user_id) DO NOTHING`;
  return Response.json({ agent: { id: instance.id, status: instance.status } }, { status: 201 });
}
