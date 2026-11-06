import { sql } from '@/lib/db';
import { userId } from '@/lib/user';

// One chat per job the agent worked on, newest first, from Postgres.
export async function GET() {
  const rows = await sql`
    SELECT j.id, j.filename, j.status, j.instructions, j.session_id, count(m.id)::int AS message_count
    FROM jobs j LEFT JOIN chat_messages m ON m.job_id = j.id
    WHERE j.user_id = ${await userId()} AND j.session_id IS NOT NULL
    GROUP BY j.id ORDER BY j.created_at DESC`;
  return Response.json({
    data: rows.map((row) => ({ id: row.id, title: row.instructions, filename: row.filename, status: row.status, sessionId: row.session_id, messageCount: row.message_count })),
  });
}
