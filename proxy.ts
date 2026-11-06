// Runs before every request. Two jobs:
//   1. Give each browser a user id in a cookie. This example has no sign-in: the cookie
//      is the user, and each user gets one Agent37 agent. Swap in real auth (such as
//      Neon Auth) before you put it in front of other people.
//   2. Guard writes to /api: require JSON, which forces a CORS preflight this app never
//      answers, and refuse browser requests from another origin.
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith('/api/');
  if (isApi && request.method !== 'GET' && request.method !== 'HEAD') {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return NextResponse.json({ error: 'Send the request with Content-Type: application/json.' }, { status: 415 });
    }
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.headers.get('host')) {
      return NextResponse.json({ error: 'Cross-origin requests are not allowed.' }, { status: 403 });
    }
  }

  if (request.cookies.get('uid')) return NextResponse.next();
  // The first request has no cookie yet: set it on the request too, so this request's
  // route handler already sees the new id.
  const uid = crypto.randomUUID();
  request.cookies.set('uid', uid);
  const response = NextResponse.next({ request });
  response.cookies.set('uid', uid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365 });
  return response;
}

export const config = { matcher: ['/((?!_next/|icon.svg).*)'] };
