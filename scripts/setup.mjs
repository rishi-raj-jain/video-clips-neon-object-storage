// One-time setup, after `neon deploy` has written DATABASE_URL and the AWS_* storage
// credentials into .env: create the tables, and let browsers upload to the bucket.
import { neon } from '@neondatabase/serverless';
import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);

// One agent per user, and one row per upload.
await sql`CREATE TABLE IF NOT EXISTS agents (
  user_id     text PRIMARY KEY,
  instance_id text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
)`;
await sql`CREATE TABLE IF NOT EXISTS jobs (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  filename     text NOT NULL,
  input_key    text NOT NULL,
  clip_count   int  NOT NULL,
  instructions text NOT NULL,
  status       text NOT NULL DEFAULT 'uploading',
  session_id   text,
  clips        jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
)`;
await sql`CREATE INDEX IF NOT EXISTS jobs_user_created ON jobs (user_id, created_at DESC)`;

// Every object a job has in the bucket, recorded by the clipper function as it sees
// them, so the app lists them with one query instead of listing the bucket.
await sql`CREATE TABLE IF NOT EXISTS objects (
  key        text PRIMARY KEY,
  user_id    text NOT NULL,
  job_id     text NOT NULL,
  kind       text NOT NULL,
  size       bigint,
  created_at timestamptz NOT NULL DEFAULT now()
)`;
await sql`CREATE INDEX IF NOT EXISTS objects_user_job ON objects (user_id, job_id)`;

// Each job's chat with the agent: the brief, every tool call the agent made, and its
// reply. Agent37 keeps only the messages; the tool calls exist only on the live
// stream, which the function follows and writes here.
await sql`CREATE TABLE IF NOT EXISTS chat_messages (
  id         bigserial PRIMARY KEY,
  job_id     text NOT NULL,
  role       text NOT NULL,
  content    text NOT NULL,
  tool       text,
  state      text,
  created_at timestamptz NOT NULL DEFAULT now()
)`;
await sql`CREATE INDEX IF NOT EXISTS chat_messages_job ON chat_messages (job_id, id)`;
console.log('tables ready');

// The browser PUTs the video straight to a presigned URL and plays clips from presigned
// GET URLs, so the bucket has to answer cross-origin requests from the app. This is
// S3's PutBucketCors: an XML body on ?cors, with the body's MD5 that S3 requires.
const origins = (process.env.APP_ORIGINS || 'http://127.0.0.1:3000,http://localhost:3000').split(',');
const cors = `<CORSConfiguration><CORSRule>${origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  service: 's3',
});
const res = await aws.fetch(`${process.env.AWS_ENDPOINT_URL_S3}/videos?cors`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/xml', 'Content-MD5': createHash('md5').update(cors).digest('base64') },
  body: cors,
});
if (!res.ok) throw new Error(`PutBucketCors: ${res.status} ${await res.text()}`);
console.log(`bucket CORS ready for ${origins.join(', ')}`);
