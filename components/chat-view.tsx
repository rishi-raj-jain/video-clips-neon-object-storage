'use client';

// One job's chat with its agent, read from Postgres: the brief the clipper function
// sent, every tool call the agent made (its ffmpeg and curl commands), and its reply.
// The function writes these rows while the agent works, so polling shows the job live.
import useSWR from 'swr';
import { Streamdown } from 'streamdown';
import { CheckCircle2, Loader2, TerminalSquare, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { fetcher } from '@/lib/fetcher';
import type { View } from './app-sidebar';

type Message = { id: number; role: 'user' | 'assistant' | 'tool'; content: string; tool: string | null; state: 'running' | 'done' | 'failed' | null };

const STATE_ICON = {
  running: <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-blue-700" />,
  done: <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-700" />,
  failed: <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />,
};

export function ChatView({ chat }: { chat: Extract<View, { type: 'chat' }>['chat'] }) {
  const { data } = useSWR<{ status: string; messages: Message[] }>(`/api/chats/${chat.id}`, fetcher, {
    refreshInterval: (latest) => (latest?.status === 'processing' || latest?.status === 'uploading' ? 2000 : 0),
  });
  const working = data?.status === 'processing';
  const tools = data?.messages.filter((m) => m.role === 'tool') ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {chat.title}
          {working && (
            <Badge variant="outline" className="text-blue-700">
              Agent is working
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Clipping {chat.filename} · Agent37 session <code>{chat.sessionId}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data?.messages
          .filter((m) => m.role === 'user')
          .map((m) => (
            // The brief is long and written for the agent, so it starts collapsed.
            <Collapsible key={m.id} className="rounded-lg border bg-muted/40 px-4 py-3">
              <CollapsibleTrigger className="w-full text-left text-sm font-medium">Brief from the clipper function</CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-3 whitespace-pre-wrap font-sans text-xs text-muted-foreground">{m.content}</pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        {(tools.length > 0 || working) && (
          <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {working && <Loader2 className="size-4 animate-spin" />} Commands on the agent's computer
            </div>
            {tools.length === 0 && <p className="text-xs text-muted-foreground">Waiting for the first command...</p>}
            <ul className="flex flex-col gap-1.5">
              {tools.map((tool) => (
                <li key={tool.id} className="flex items-start gap-2 text-xs">
                  {STATE_ICON[tool.state ?? 'done']}
                  <TerminalSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <code className="break-all">{tool.content}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data?.messages
          .filter((m) => m.role === 'assistant')
          .map((m) => (
            <div key={m.id} className="text-sm">
              <Streamdown>{m.content}</Streamdown>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
