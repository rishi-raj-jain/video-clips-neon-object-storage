import { sql } from '@/lib/db';
import { userId } from '@/lib/user';

type Row = { key: string; kind: string; size: number | null; created_at: string; job_id: string; filename: string; status: string; job_created_at: string };

// Everything this user has in the bucket, grouped by job: the video they uploaded, and
// the clips, thumbnails, and manifest the agent made from it. The clipper function
// records each object in Postgres as it sees it, so this is one query, not a listing of
// the bucket.
export async function GET() {
  const rows = (await sql`
    SELECT o.key, o.kind, o.size, o.created_at, j.id AS job_id, j.filename, j.status, j.created_at AS job_created_at
    FROM objects o JOIN jobs j ON j.id = o.job_id
    WHERE o.user_id = ${await userId()}
    ORDER BY j.created_at DESC,
      CASE o.kind WHEN 'upload' THEN 0 WHEN 'clip' THEN 1 WHEN 'thumbnail' THEN 2 ELSE 3 END, o.key`) as Row[];

  const groups = new Map<string, { job: { id: string; filename: string; status: string }; objects: object[] }>();
  for (const row of rows) {
    const group = groups.get(row.job_id) ?? { job: { id: row.job_id, filename: row.filename, status: row.status }, objects: [] };
    group.objects.push({ key: row.key, kind: row.kind, size: Number(row.size ?? 0), lastModified: row.created_at, name: row.kind === 'manifest' ? 'manifest.json' : row.key.split('/').pop() });
    groups.set(row.job_id, group);
  }
  return Response.json({ data: [...groups.values()] });
}
