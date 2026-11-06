'use client';

// One object from the bucket, previewed through a short-lived presigned URL: a player
// for videos, the image for thumbnails, and the JSON for the agent's manifest.
import useSWR from 'swr';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetcher } from '@/lib/fetcher';
import { formatSize, type StoredObject } from './app-sidebar';

const KIND = { upload: 'Uploaded video', clip: 'Clip the agent cut', thumbnail: 'Thumbnail the agent made', manifest: 'Manifest the agent wrote' };

export function ObjectView({ object }: { object: StoredObject }) {
  const { data } = useSWR<{ url: string }>(`/api/objects/url?key=${encodeURIComponent(object.key)}`, fetcher, { revalidateOnFocus: false });
  // The bucket's CORS rules allow GET from the app, so the browser can read the JSON.
  const { data: manifest } = useSWR(object.kind === 'manifest' && data ? data.url : null, (url: string) => fetch(url).then((r) => r.json()));

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>{object.kind === 'upload' ? object.name : object.name}</CardTitle>
          <CardDescription>
            {KIND[object.kind]} · {formatSize(object.size)} · {new Date(object.lastModified).toLocaleString()}
          </CardDescription>
          <code className="break-all text-xs text-muted-foreground">videos/{object.key}</code>
        </div>
        {data && (
          <Button variant="outline" size="sm" asChild>
            <a href={data.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open presigned URL
            </a>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!data ? (
          <div className="aspect-video w-full animate-pulse rounded-md bg-muted" />
        ) : object.kind === 'upload' || object.kind === 'clip' ? (
          <video key={data.url} className="aspect-video w-full rounded-md bg-black" src={data.url} controls />
        ) : object.kind === 'thumbnail' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="w-full rounded-md" src={data.url} alt={object.name} />
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">{manifest ? JSON.stringify(manifest, null, 2) : 'Loading...'}</pre>
        )}
      </CardContent>
    </Card>
  );
}
