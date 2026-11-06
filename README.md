# video-clips-neon-object-storage

A video clipping app on [Agent37](https://www.agent37.com/docs) and [Neon](https://neon.com/docs). A user uploads a video to a [Neon Object Storage](https://neon.com/docs/storage/overview) bucket, a [Function Trigger](https://neon.com/docs/compute/functions/triggers/object-storage) wakes that user's Agent37 agent to cut clips with ffmpeg, and the clips go back to the bucket for the app to serve with presigned URLs. [Neon AI Gateway](https://neon.com/docs/ai-gateway/overview) titles each clip from its thumbnail.

Next.js and shadcn/ui for the app, a Hono function on Neon, `aws4fetch` for Object Storage, and the AI SDK with `@neon/ai-sdk-provider` for the gateway.

## How it works

1. The app gives each user one Agent37 agent (`agent37-hermes`, which ships with ffmpeg), with auto-sleep on.
2. The browser asks the app for a presigned PUT URL and uploads the video straight to `uploads/<user>/<job>/` in the `videos` bucket.
3. That upload fires the `video-uploaded` trigger. The `clipper` function ([`functions/clipper.ts`](./functions/clipper.ts)) signs URLs for exactly this job's outputs, writes them to the agent's disk with exec (which wakes a sleeping agent), and starts a turn telling the agent what to cut.
4. The agent downloads the video, picks moments with ffmpeg, and uploads the clips, thumbnails, and a manifest with `curl`. It never gets storage credentials, only this job's signed URLs.
5. The manifest under `manifests/` fires the `clips-finished` trigger. The function asks Gemini through AI Gateway for a title and caption from each thumbnail, and marks the job done in Postgres.
6. The app lists the clips with presigned GET URLs to play and download them.

Everything on the Neon side (bucket, AI Gateway, function, both triggers) is declared in [`neon.ts`](./neon.ts) and applied with `neon deploy`.

## Run it

You need:

- An [Agent37 API key](https://www.agent37.com/dashboard/cloud/api-keys) and at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing). Each user's agent gets a $1 managed-model budget.
- A [Neon](https://console.neon.tech) account, the [Neon CLI](https://neon.com/docs/cli/install), and AI Gateway credits on the **Billing** page.

```bash
npm install
cp .env.example .env            # add AGENT37_API_KEY
neon login
neon link                       # create a project in aws-us-east-2, aws-us-east-1, aws-eu-central-1, or aws-ap-southeast-1
neon deploy --env .env          # bucket, AI Gateway, function, triggers; pulls the rest of .env
npm run setup                   # tables, and CORS so the browser can upload to the bucket
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), create your agent, and upload a video. A one-minute video takes about two minutes end to end.

## Good to know

- **The app has no sign-in.** A cookie is the user, and each user gets one agent. Put real auth in front of it before other people use it.
- **The idle timeout must outlast a job.** Auto-sleep counts only traffic on the agent's URLs, not its own work, so the agent's `idle_timeout_seconds` is 1800.
- **Retries are idempotent.** A trigger can deliver the same upload more than once. The function claims the job with one `UPDATE ... WHERE status = 'uploading'`, and asks Neon to retry with `503` and `Retry-After` if waking the agent fails.
- **Image input to AI Gateway goes in as bytes.** Gemini on the gateway rejects image URLs, so the function reads the thumbnail from the bucket and sends it inline.
- **Presigned PUT URLs bind the content type.** `aws4fetch` signs `Content-Type` only with `allHeaders: true`. Without it, an upload URL would accept any type.

Full Agent37 API reference: [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt). Neon Functions: [neon.com/docs/compute/functions](https://neon.com/docs/compute/functions/overview).
