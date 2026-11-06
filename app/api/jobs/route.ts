import { sql, type Job } from '@/lib/db';
import { keys, presignDownload, presignGet, presignPut } from '@/lib/storage';
import { userId } from '@/lib/user';

const MAX_BYTES = 200 * 1024 * 1024;

// The user's jobs, newest first. Clips are private objects, so each one gets
// short-lived presigned GET URLs: one to play it, one for its thumbnail, and one that
// downloads it.
export async function GET() {
  const jobs = (await sql`SELECT * FROM jobs WHERE user_id = ${await userId()} ORDER BY created_at DESC LIMIT 20`) as Job[];
  const data = await Promise.all(
    jobs.map(async (job) => ({
      ...job,
      clips: job.clips
        ? await Promise.all(
            job.clips.map(async (clip) => ({
              ...clip,
              url: await presignGet(clip.clipKey),
              thumbUrl: await presignGet(clip.thumbKey),
              downloadUrl: await presignDownload(clip.clipKey, `clip-${clip.index}.mp4`),
            }))
          )
        : null,
    }))
  );
  return Response.json({ data });
}

// Start a job: record it, and return a presigned PUT URL the browser uploads the video
// to directly. The upload itself is what fires the trigger.
export async function POST(request: Request) {
  const uid = await userId();
  const { filename, contentType, size, clipCount, instructions } = await request.json();
  if (typeof filename !== 'string' || !/^video\//.test(contentType) || !(size > 0 && size <= MAX_BYTES)) {
    return Response.json({ error: 'Send a video file up to 200 MB.' }, { status: 400 });
  }
  const count = Math.min(Math.max(Number.parseInt(clipCount, 10) || 3, 1), 5);
  const ask = typeof instructions === 'string' && instructions.trim() ? instructions.trim().slice(0, 500) : 'Pick the most interesting moments.';

  const [agent] = await sql`SELECT instance_id FROM agents WHERE user_id = ${uid}`;
  if (!agent) return Response.json({ error: 'Create your agent first.' }, { status: 409 });

  const jobId = crypto.randomUUID();
  // Keep the extension (ffmpeg uses it) and drop anything else that's not a plain name.
  const safeName = filename.replace(/[^\w.-]+/g, '_').slice(-80) || 'video.mp4';
  const inputKey = keys.upload(uid, jobId, safeName);
  await sql`
    INSERT INTO jobs (id, user_id, filename, input_key, clip_count, instructions)
    VALUES (${jobId}, ${uid}, ${filename.slice(0, 200)}, ${inputKey}, ${count}, ${ask})`;

  return Response.json({ jobId, uploadUrl: await presignPut(inputKey, contentType, 900) }, { status: 201 });
}
