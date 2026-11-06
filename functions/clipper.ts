// The clipper function. Two Object Storage triggers call it:
//
//   POST /uploaded  a video landed under uploads/: hand the job to the user's agent,
//                   and record the agent's chat as it works
//   POST /finished  the agent's manifest landed under manifests/: title each clip with
//                   AI Gateway and mark the job done
//
// The function also keeps the app's index in Postgres: every object the job has in the
// bucket (objects), and the agent's chat, tool calls included (chat_messages).
//
// Both routes are public, because trigger calls arrive without credentials. Neon strips
// client-set X-Neon-* headers, so X-Neon-Trigger-Invocation-Id proves the call came
// from Neon. Deliveries can repeat, so both handlers are idempotent.
import { Hono } from 'hono';
import { waitUntil } from '@neon/functions';
import { neon as gateway } from '@neon/ai-sdk-provider';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { sql, type Clip, type Job } from '../lib/db';
import { keys, objectSize, presignGet, presignPut, readObject } from '../lib/storage';
import { exec, startTurn, waitHealthy, type TurnEvent } from '../lib/agent37';

const app = new Hono();

type TriggerEvent = { data: { bucket_name: string; object_key: string }; previous_attempts: unknown[] };

app.use('*', async (c, next) => {
  if (!c.req.header('x-neon-trigger-invocation-id')) return c.json({ error: 'not a trigger call' }, 403);
  await next();
});

// What the agent is told. The signed URLs stay in job.json on the instance, so the
// model never has to copy them; put.sh reads them and uploads with curl.
function brief(job: Job, dir: string, ext: string) {
  return `You are the clipping agent for a video app. A user uploaded a video and wants ${job.clip_count} clip(s).
Their request: "${job.instructions}"

Everything for this job is in ${dir}. job.json holds signed URLs; never print them.
1. Download the video: cd ${dir} && curl -sf -o input${ext} "$(python3 -c 'import json; print(json.load(open("job.json"))["input"])')"
2. Inspect it with ffprobe. To find good moments, use ffmpeg: scene changes with -vf "select='gt(scene,0.3)',showinfo" -f null -, and loudness with -af ebur128 or silencedetect.
3. Cut exactly ${job.clip_count} clip(s), each 3 to 20 seconds, no overlap, in time order:
   ffmpeg -y -ss START -t LENGTH -i input${ext} -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart clip-N.mp4
   and a thumbnail from the middle of each clip:
   ffmpeg -y -ss MIDDLE -i input${ext} -frames:v 1 -vf scale=640:-2 thumb-N.jpg
4. Upload each one: sh put.sh clip N clip-N.mp4 and sh put.sh thumb N thumb-N.jpg (N starts at 1).
5. Last, write manifest.json as {"clips":[{"index":1,"start":12.0,"end":20.5,"reason":"why you picked it"}]} and run sh put.sh manifest manifest.json.
   The manifest tells the app the job is done, so upload it only after every clip. If you can't finish, upload {"error":"what went wrong"} as the manifest instead.
Reply with one short line per clip.`;
}

// Uploads one result to its signed URL. Usage: put.sh clip|thumb N FILE, or put.sh manifest FILE.
const PUT_SH = `#!/bin/sh
set -e
cd "$(dirname "$0")"
case "$1" in
  clip) url=$(python3 -c "import json,sys; print(json.load(open('job.json'))['clips'][int(sys.argv[1])-1])" "$2"); type=video/mp4; file=$3 ;;
  thumb) url=$(python3 -c "import json,sys; print(json.load(open('job.json'))['thumbs'][int(sys.argv[1])-1])" "$2"); type=image/jpeg; file=$3 ;;
  manifest) url=$(python3 -c "import json; print(json.load(open('job.json'))['manifest'])"); type=application/json; file=$2 ;;
  *) echo "usage: put.sh clip|thumb N FILE | put.sh manifest FILE" >&2; exit 1 ;;
esac
curl -sf -X PUT -H "Content-Type: $type" --upload-file "$file" "$url" && echo "uploaded $file"
`;

// Record an object the job has in the bucket. Redeliveries write the same row again.
const recordObject = (key: string, userId: string, jobId: string, kind: string, size: number | null) =>
  sql`INSERT INTO objects (key, user_id, job_id, kind, size) VALUES (${key}, ${userId}, ${jobId}, ${kind}, ${size})
      ON CONFLICT (key) DO UPDATE SET size = EXCLUDED.size`;

// Follow the agent's turn to the end and write it to chat_messages: one row per tool
// call (updated when it finishes), and the agent's reply. Agent37 keeps only the
// messages, so the live stream is the one place the tool calls exist. Reading it also
// keeps bytes moving through the agent's URL, so it doesn't fall asleep mid-job.
async function recordTurn(jobId: string, events: AsyncGenerator<TurnEvent>) {
  try {
    for await (const { event, data } of events) {
      if (event === 'response.tool_call.started') {
        await sql`INSERT INTO chat_messages (job_id, role, content, tool, state)
                  VALUES (${jobId}, 'tool', ${(data.label || data.tool).split('\n')[0].slice(0, 2000)}, ${data.tool}, 'running')`;
      } else if (event === 'response.tool_call.completed' || event === 'response.tool_call.failed') {
        // A completion names the tool but not the call: finish the oldest running one.
        const state = event.endsWith('completed') ? 'done' : 'failed';
        await sql`UPDATE chat_messages SET state = ${state}
                  WHERE id = (SELECT id FROM chat_messages WHERE job_id = ${jobId} AND tool = ${data.tool} AND state = 'running' ORDER BY id LIMIT 1)`;
      } else if (event === 'response.completed') {
        await sql`UPDATE chat_messages SET state = 'done' WHERE job_id = ${jobId} AND state = 'running'`;
        await sql`INSERT INTO chat_messages (job_id, role, content) VALUES (${jobId}, 'assistant', ${data.output_text || '(no reply)'})`;
      } else if (event === 'response.failed') {
        await sql`INSERT INTO chat_messages (job_id, role, content) VALUES (${jobId}, 'assistant', ${`The turn failed: ${data.error?.message || 'unknown error'}`})`;
      }
    }
  } catch (err) {
    console.error(`job ${jobId}: stopped following the turn: ${(err as Error).message}`);
  }
}

app.post('/uploaded', async (c) => {
  const { data, previous_attempts } = await c.req.json<TriggerEvent>();
  const [, userId, jobId, filename] = data.object_key.split('/');
  console.log(`video uploaded: ${data.object_key}`);

  // Claim the job: only the first delivery moves it out of "uploading".
  const [job] = (await sql`
    UPDATE jobs SET status = 'processing', updated_at = now()
    WHERE id = ${jobId} AND user_id = ${userId} AND status = 'uploading'
    RETURNING *`) as Job[];
  if (!job) return c.json({ ok: true, skipped: 'job already claimed or unknown' });

  try {
    const [agent] = await sql`SELECT instance_id FROM agents WHERE user_id = ${userId}`;
    if (!agent) throw new Error('this user has no agent');

    // Signed URLs for exactly this job's objects, valid for two hours. The agent gets
    // these and nothing else: no storage credentials ever reach the instance.
    const ttl = 2 * 3600;
    const n = Array.from({ length: job.clip_count }, (_, i) => i + 1);
    const jobFile = {
      input: await presignGet(job.input_key, ttl),
      clips: await Promise.all(n.map((i) => presignPut(keys.clip(userId, jobId, i), 'video/mp4', ttl))),
      thumbs: await Promise.all(n.map((i) => presignPut(keys.thumb(userId, jobId, i), 'image/jpeg', ttl))),
      manifest: await presignPut(keys.manifest(userId, jobId), 'application/json', ttl),
    };

    // Exec wakes a sleeping agent. Write the job's files, then start the turn.
    const dir = `~/jobs/${jobId}`;
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    await exec(
      agent.instance_id,
      `mkdir -p ${dir} && echo ${b64(JSON.stringify(jobFile))} | base64 -d > ${dir}/job.json && echo ${b64(PUT_SH)} | base64 -d > ${dir}/put.sh`
    );
    await waitHealthy(agent.instance_id);
    const ext = (filename.match(/\.[a-z0-9]{2,5}$/i)?.[0] || '.mp4').toLowerCase();
    const prompt = brief(job, dir, ext);
    const turn = await startTurn(agent.instance_id, prompt);

    await sql`UPDATE jobs SET session_id = ${turn.sessionId}, updated_at = now() WHERE id = ${jobId}`;
    await recordObject(job.input_key, userId, jobId, 'upload', await objectSize(job.input_key));
    await sql`INSERT INTO chat_messages (job_id, role, content) VALUES (${jobId}, 'user', ${prompt})`;
    // Answer the trigger now, and keep following the turn for up to 15 minutes.
    waitUntil(recordTurn(jobId, turn.events));
    return c.json({ ok: true, session_id: turn.sessionId });
  } catch (err) {
    const message = String((err as Error).message || err);
    console.error(`job ${jobId}: ${message}`);
    // Give the job back and ask Neon to redeliver in a minute, a few times. After that,
    // mark it failed and stop.
    if (previous_attempts.length < 3) {
      await sql`UPDATE jobs SET status = 'uploading', updated_at = now() WHERE id = ${jobId}`;
      return c.json({ error: message }, 503, { 'Retry-After': '60' });
    }
    await sql`UPDATE jobs SET status = 'failed', error = ${message}, updated_at = now() WHERE id = ${jobId}`;
    return c.json({ ok: false, error: message });
  }
});

const ClipText = z.object({
  title: z.string().describe('A short, specific title for the clip, at most 6 words'),
  caption: z.string().describe('One sentence describing what happens in the clip'),
});

// One vision call per clip through Neon AI Gateway. The provider reads the gateway
// credentials Neon injects into the function. The thumbnail goes in as bytes, which
// the gateway accepts for Gemini; a URL to the image would be rejected.
async function describe(thumbKey: string, reason: string) {
  const { output } = await generateText({
    model: gateway('gemini-3-flash'),
    output: Output.object({ schema: ClipText }),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `This is a frame from a video clip. The editor picked it because: ${reason}. Write a title and a caption for the clip.` },
          { type: 'image', image: await readObject(thumbKey), mediaType: 'image/jpeg' },
        ],
      },
    ],
  });
  return output;
}

app.post('/finished', async (c) => {
  const { data } = await c.req.json<TriggerEvent>();
  const [, userId, file] = data.object_key.split('/');
  const jobId = file.replace(/\.json$/, '');
  console.log(`manifest uploaded: ${data.object_key}`);

  const [job] = (await sql`SELECT * FROM jobs WHERE id = ${jobId} AND user_id = ${userId}`) as Job[];
  if (!job || job.status === 'done' || job.status === 'failed') return c.json({ ok: true, skipped: true });

  let manifest: { clips?: { index: number; start: number; end: number; reason?: string }[]; error?: string };
  try {
    manifest = JSON.parse((await readObject(data.object_key)).toString('utf8'));
  } catch {
    manifest = { error: 'the agent uploaded a manifest that is not JSON' };
  }
  await recordObject(data.object_key, userId, jobId, 'manifest', await objectSize(data.object_key));
  if (manifest.error || !manifest.clips?.length) {
    await sql`UPDATE jobs SET status = 'failed', error = ${manifest.error || 'no clips in the manifest'}, updated_at = now() WHERE id = ${jobId}`;
    return c.json({ ok: true, failed: true });
  }

  // Keep only clips whose video really landed in the bucket, record them, and title each one.
  const clips: Clip[] = [];
  for (const entry of manifest.clips) {
    const clipKey = keys.clip(userId, jobId, entry.index);
    const thumbKey = keys.thumb(userId, jobId, entry.index);
    const [clipBytes, thumbBytes] = await Promise.all([objectSize(clipKey), objectSize(thumbKey)]);
    if (clipBytes === null) continue;
    await recordObject(clipKey, userId, jobId, 'clip', clipBytes);
    if (thumbBytes !== null) await recordObject(thumbKey, userId, jobId, 'thumbnail', thumbBytes);
    const reason = entry.reason || 'it stood out';
    const text = thumbBytes !== null
      ? await describe(thumbKey, reason).catch((err) => {
          console.error(`describe clip ${entry.index}: ${err.message}`);
          return null;
        })
      : null;
    clips.push({
      index: entry.index,
      start: entry.start,
      end: entry.end,
      reason,
      title: text?.title || `Clip ${entry.index}`,
      caption: text?.caption || reason,
      clipKey,
      thumbKey,
    });
  }

  await sql`
    UPDATE jobs SET status = ${clips.length ? 'done' : 'failed'}, clips = ${JSON.stringify(clips)}::jsonb,
      error = ${clips.length ? null : 'no clip files were uploaded'}, updated_at = now()
    WHERE id = ${jobId}`;
  return c.json({ ok: true, clips: clips.length });
});

export default app;
