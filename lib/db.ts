// Postgres on the same Neon branch, over the HTTP driver: one fetch per query, which
// suits both the Next.js routes and the function.
import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL!);

export type Clip = { index: number; start: number; end: number; reason: string; title: string; caption: string; clipKey: string; thumbKey: string };

export type Job = {
  id: string;
  user_id: string;
  filename: string;
  input_key: string;
  clip_count: number;
  instructions: string;
  status: 'uploading' | 'processing' | 'done' | 'failed';
  session_id: string | null;
  clips: Clip[] | null;
  error: string | null;
  created_at: string;
};
