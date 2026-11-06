'use client';

// The whole page: a sidebar with the user's objects and agent chats, and a main area
// that shows the upload form and jobs, one object, or one chat. SWR polls the API while
// anything is in progress; the browser uploads the video straight to Neon Object
// Storage with the presigned URL the server returns.
import { useCallback, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { AppSidebar, type View } from '@/components/app-sidebar';
import { ChatView } from '@/components/chat-view';
import { ObjectView } from '@/components/object-view';
import { fetcher } from '@/lib/fetcher';
import type { Clip, Job } from '@/lib/db';
import { cn } from '@/lib/utils';

type Agent = { id: string; status: string } | null;
type JobView = Omit<Job, 'clips'> & { clips: (Clip & { url: string; thumbUrl: string; downloadUrl: string })[] | null };

async function post(url: string, body?: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// fetch can't report upload progress, so the PUT to the presigned URL uses XHR. The
// Content-Type must match the one the URL was signed for.
function putFile(url: string, file: File, onProgress: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed: check the bucket CORS rules'));
    xhr.send(file);
  });
}

const STATUS: Record<Job['status'], { label: string; className: string }> = {
  uploading: { label: 'Uploading', className: 'text-amber-700' },
  processing: { label: 'Agent is cutting', className: 'text-blue-700' },
  done: { label: 'Done', className: 'text-green-700' },
  failed: { label: 'Failed', className: 'text-destructive' },
};

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function ClipperApp() {
  const { data: agentData, mutate: refreshAgent } = useSWR<{ agent: Agent }>('/api/agent', fetcher, { refreshInterval: 10000 });
  const { data: jobsData, mutate: refreshJobs } = useSWR<{ data: JobView[] }>('/api/jobs', fetcher, {
    // Poll quickly only while a job is still moving.
    refreshInterval: (latest) => (latest?.data.some((j) => j.status === 'uploading' || j.status === 'processing') ? 3000 : 15000),
  });
  const agent = agentData?.agent;
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<View>({ type: 'home' });
  const { mutate } = useSWRConfig();

  async function createAgent() {
    setCreating(true);
    try {
      await post('/api/agent');
      toast.success('Your agent is ready. Upload a video to put it to work.');
      refreshAgent();
    } catch (err) {
      toast.error(`Could not create your agent: ${(err as Error).message}`);
    }
    setCreating(false);
  }

  // A new upload shows up in the sidebar right away, without waiting for the next poll.
  const onUploaded = () => {
    refreshJobs();
    mutate('/api/objects');
  };

  return (
    <SidebarProvider>
      <AppSidebar view={view} onSelect={setView} />
      <SidebarInset>
        <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <SidebarTrigger />
            Video clips <span className="font-normal text-muted-foreground">· Agent37 + Neon Object Storage example</span>
          </div>
          {agent && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Your agent <code>{agent.id}</code>
              <Badge variant="outline" className={agent.status === 'running' ? 'text-green-700' : ''}>
                {agent.status === 'sleeping' ? 'Sleeping, an upload wakes it' : agent.status}
              </Badge>
            </div>
          )}
        </header>
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
          {view.type === 'object' ? (
            <ObjectView object={view.object} />
          ) : view.type === 'chat' ? (
            <ChatView chat={view.chat} />
          ) : (
            <>
              {agentData && !agent ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Create your clipping agent</CardTitle>
                    <CardDescription>
                      You get your own Agent37 agent with ffmpeg on its computer. When you upload a video, a Neon Function Trigger wakes it to cut your clips.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button onClick={createAgent} disabled={creating}>
                      {creating ? 'Creating...' : 'Create my agent'}
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                agent && <UploadForm onUploaded={onUploaded} />
              )}
              {jobsData?.data.map((job) => <JobCard key={job.id} job={job} />)}
            </>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [clipCount, setClipCount] = useState('3');
  const [instructions, setInstructions] = useState('Pick the most action-packed moments.');
  const [progress, setProgress] = useState<number | null>(null);

  const onDrop = useCallback((accepted: File[]) => setFile(accepted[0] ?? null), []);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: { 'video/*': [] }, maxFiles: 1, maxSize: 200 * 1024 * 1024 });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setProgress(0);
    try {
      // 1. The server records the job and signs an upload URL for it.
      const { uploadUrl } = await post('/api/jobs', { filename: file.name, contentType: file.type, size: file.size, clipCount, instructions });
      onUploaded();
      // 2. The browser uploads straight to the bucket. That upload fires the trigger.
      await putFile(uploadUrl, file, setProgress);
      toast.success('Uploaded. Your agent is on it.');
      setFile(null);
      onUploaded();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setProgress(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload a video</CardTitle>
        <CardDescription>It goes straight to your Neon Object Storage bucket, and your agent cuts the clips you ask for.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div
            {...getRootProps()}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-sm text-muted-foreground transition-colors',
              isDragActive ? 'border-foreground bg-muted' : 'hover:border-foreground/40'
            )}
          >
            <input {...getInputProps()} />
            {file ? (
              <span className="text-foreground">
                {file.name} <span className="text-muted-foreground">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
              </span>
            ) : (
              <span>Drop a video here, or click to choose one (up to 200 MB)</span>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
            <div className="flex flex-col gap-2">
              <Label>Clips</Label>
              <Select value={clipCount} onValueChange={setClipCount}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['1', '2', '3', '4', '5'].map((n) => (
                    <SelectItem key={n} value={n}>
                      {n} {n === '1' ? 'clip' : 'clips'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="instructions">What should the agent look for?</Label>
              <Textarea id="instructions" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </div>
          </div>
          {progress !== null && <Progress value={progress} />}
          <div>
            <Button type="submit" disabled={!file || progress !== null}>
              {progress !== null ? `Uploading ${progress}%` : 'Upload and cut clips'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function JobCard({ job }: { job: JobView }) {
  const status = STATUS[job.status];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {job.filename}
          <Badge variant="outline" className={status.className}>
            {status.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          {job.clip_count} {job.clip_count === 1 ? 'clip' : 'clips'} · {job.instructions}
        </CardDescription>
      </CardHeader>
      {(job.status === 'processing' || job.status === 'failed' || job.clips?.length) && (
        <CardContent>
          {job.status === 'processing' && (
            <p className="animate-pulse text-sm text-muted-foreground">The trigger woke your agent. It's finding moments with ffmpeg and uploading clips to the bucket.</p>
          )}
          {job.status === 'failed' && <p className="text-sm text-destructive">{job.error}</p>}
          {job.clips?.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {job.clips.map((clip) => (
                <div key={clip.index} className="flex flex-col gap-2">
                  <video className="aspect-video w-full rounded-md bg-black" src={clip.url} poster={clip.thumbUrl} controls preload="none" />
                  <div className="text-sm font-medium">{clip.title}</div>
                  <div className="text-xs text-muted-foreground">{clip.caption}</div>
                  <div className="text-xs text-muted-foreground">
                    {time(clip.start)} to {time(clip.end)} ·{' '}
                    <a className="underline underline-offset-2" href={clip.downloadUrl}>
                      Download
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}
