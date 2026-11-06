// SWR's fetcher for this app's own API: JSON in, an Error with the server's message out.
export async function fetcher(url: string) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
