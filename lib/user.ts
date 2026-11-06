import 'server-only';
import { cookies } from 'next/headers';

// The user id proxy.ts puts in a cookie. Every route scopes its reads and writes to it.
export async function userId() {
  const id = (await cookies()).get('uid')?.value;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('missing user id');
  return id;
}
