import { defineConfig } from '@neon/config/v1';

// What this app needs from Neon, applied with `neon deploy`:
//   - a private bucket for uploads, clips, thumbnails, and manifests,
//   - AI Gateway, which the function calls to title each clip,
//   - one function, clipper, with a route per trigger,
//   - two Object Storage triggers: a new upload wakes the user's agent, and the
//     agent's manifest marks the job done.
// Postgres needs no declaration: every branch has it.
export default defineConfig({
  aiGateway: true,
  buckets: {
    videos: {},
  },
  functions: {
    clipper: {
      name: 'Video clipper',
      source: './functions/clipper.ts',
      env: {
        AGENT37_API_KEY: process.env.AGENT37_API_KEY!,
      },
    },
  },
  triggers: {
    'video-uploaded': {
      type: 'storage_object_created',
      function: 'clipper',
      bucket: 'videos',
      prefix: 'uploads/',
      functionPath: '/uploaded',
    },
    'clips-finished': {
      type: 'storage_object_created',
      function: 'clipper',
      bucket: 'videos',
      prefix: 'manifests/',
      functionPath: '/finished',
    },
  },
});
