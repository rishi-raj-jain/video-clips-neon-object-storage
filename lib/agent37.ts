// The Agent37 calls this app makes, shared by the Next.js app and the Neon Function.
// Reference: https://www.agent37.com/docs/llms-full.txt
const API_KEY = process.env.AGENT37_API_KEY!;
const API = 'https://api.agent37.com/v1';
const instanceUrl = (id: string, path: string) => `https://${id}.agent37.app${path}`;

// Tags this app's instances in metadata, so it can share a workspace with other apps.
export const APP_TAG = 'video-clips-neon-object-storage';

export type Instance = { id: string; status: string; metadata?: Record<string, string> };

// The Sandbox API takes the key as a Bearer token; instance URLs and exec take it raw.
async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = url.startsWith(API) ? { Authorization: `Bearer ${API_KEY}` } : { 'X-Agent37-Key': API_KEY };
  const res = await fetch(url, { ...init, headers: { ...headers, 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof body?.error === 'object' ? body.error.message : body?.error;
    throw new Error(`Agent37 ${res.status}: ${message || 'request failed'}`);
  }
  return body as T;
}

// One Hermes agent per user. Hermes ships with ffmpeg, and its managed model needs a
// budget: $1 here. Auto-sleep drops the instance to disk-only billing when nobody is
// using it, and an upload wakes it again. The idle timeout has to outlast a job,
// because the agent's own work moves no bytes through its URLs.
export const createAgent = (userId: string) =>
  call<Instance>(`${API}/instances`, {
    method: 'POST',
    body: JSON.stringify({
      template: 'agent37-hermes',
      name: `clipper ${userId.slice(0, 8)}`,
      budget: { credit_micros: 1_000_000 },
      auto_sleep: true,
      idle_timeout_seconds: 1800,
      metadata: { app: APP_TAG, user_id: userId },
    }),
  });

export const getInstance = (id: string) => call<Instance>(`${API}/instances/${id}`);

// Exec wakes a sleeping instance before it runs the command.
export async function exec(id: string, command: string) {
  const result = await call<{ exit_code: number; stdout: string; stderr: string }>(`https://sandbox.agent37.app/v1/instances/${id}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  if (result.exit_code !== 0) throw new Error(`exec exited ${result.exit_code}: ${result.stderr.slice(0, 300)}`);
  return result.stdout;
}

// A wake that rebuilds the instance reports "running" before Hermes is up.
export async function waitHealthy(id: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(instanceUrl(id, '/v1/health'), { headers: { 'X-Agent37-Key': API_KEY }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    const health = res?.ok ? await res.json().catch(() => null) : null;
    if (health?.ok) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`agent ${id} did not come up`);
}

export type TurnEvent = { event: string; data: any };

// The gateway streams a turn as Server-Sent Events: blocks separated by a blank line,
// each with "event:" and "data:" lines. Lines starting with ":" are keepalives.
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (!frame.trim() || frame.startsWith(':')) continue;
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

// Start a turn. Returns once the agent accepts it, with the turn's ids and the rest of
// its events, which the caller can keep reading while the agent works.
export async function startTurn(id: string, input: string) {
  const res = await fetch(instanceUrl(id, '/v1/responses'), {
    method: 'POST',
    headers: { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ input, stream: true }),
  });
  if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`Agent37 ${res.status}: ${await res.text().catch(() => 'turn not started')}`);
  }
  const events = sseEvents(res.body);
  const first = await events.next();
  if (first.done || first.value.event !== 'response.created') throw new Error('the agent closed the stream before the turn started');
  return { id: first.value.data.id as string, sessionId: first.value.data.session_id as string, events };
}
