// Neon Object Storage over plain fetch, signed with aws4fetch (SigV4). Shared by the
// Next.js app and the Neon Function, which both get the same AWS_* variables: the
// function has them injected, and `neon deploy` pulls them into the app's .env.
import { AwsClient } from 'aws4fetch';

export const BUCKET = 'videos';

const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  region: process.env.AWS_REGION,
  service: 's3',
});

// Path-style URL for an object: <endpoint>/<bucket>/<key>, each key segment encoded.
const objectUrl = (key: string) => `${process.env.AWS_ENDPOINT_URL_S3}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

// Every key starts with the user's id and the job's id, so one job's URLs can only
// ever touch that job's objects. The prefixes are what the triggers watch.
export const keys = {
  upload: (userId: string, jobId: string, filename: string) => `uploads/${userId}/${jobId}/${filename}`,
  clip: (userId: string, jobId: string, n: number) => `clips/${userId}/${jobId}/clip-${n}.mp4`,
  thumb: (userId: string, jobId: string, n: number) => `clips/${userId}/${jobId}/thumb-${n}.jpg`,
  manifest: (userId: string, jobId: string) => `manifests/${userId}/${jobId}.json`,
};

// A presigned URL carries its signature in the query string, so whoever holds it can
// make that one request until it expires, with no credentials of their own.
async function presign(key: string, method: 'GET' | 'PUT', expiresIn: number, headers?: Record<string, string>, query?: Record<string, string>) {
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', String(expiresIn));
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  // allHeaders signs Content-Type too, which aws4fetch otherwise leaves out, so a PUT
  // URL accepts only the content type it was made for.
  const signed = await aws.sign(url.toString(), { method, headers, aws: { signQuery: true, allHeaders: true } });
  return signed.url;
}

export const presignGet = (key: string, expiresIn = 3600) => presign(key, 'GET', expiresIn);

// A GET URL that makes the browser save the file instead of playing it. The override is
// part of the signature, so nobody can change the filename after signing.
export const presignDownload = (key: string, filename: string, expiresIn = 3600) =>
  presign(key, 'GET', expiresIn, undefined, { 'response-content-disposition': `attachment; filename="${filename}"` });

export const presignPut = (key: string, contentType: string, expiresIn = 3600) => presign(key, 'PUT', expiresIn, { 'Content-Type': contentType });

export async function readObject(key: string) {
  const res = await aws.fetch(objectUrl(key));
  if (!res.ok) throw new Error(`GET ${key}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The object's size in bytes, or null when there's no object at that key.
export async function objectSize(key: string) {
  const res = await aws.fetch(objectUrl(key), { method: 'HEAD' });
  return res.ok ? Number(res.headers.get('content-length') ?? 0) : null;
}
