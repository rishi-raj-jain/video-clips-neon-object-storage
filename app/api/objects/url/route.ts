import { presignGet } from '@/lib/storage';
import { userId } from '@/lib/user';

// A short-lived URL to preview one object, only for keys under this user's id.
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const [root, owner] = key.split('/');
  if (!['uploads', 'clips', 'manifests'].includes(root) || owner !== (await userId()) || key.includes('..')) {
    return Response.json({ error: 'Not your object.' }, { status: 403 });
  }
  return Response.json({ url: await presignGet(key, 600) });
}
