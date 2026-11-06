'use client';

// The sidebar: every object this user has in the bucket, grouped by job, and every chat
// their agent has had. Selecting an item opens it in the main area.
import useSWR from 'swr';
import { ChevronRight, FileJson, FileVideo, ImageIcon, MessageSquare, Plus, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { fetcher } from '@/lib/fetcher';

export type StoredObject = { key: string; name: string; kind: 'upload' | 'clip' | 'thumbnail' | 'manifest'; size: number; lastModified: string };
type ObjectGroup = { job: { id: string; filename: string; status: string }; objects: StoredObject[] };
type Chat = { id: string; title: string; filename: string; status: string; sessionId: string; messageCount: number };

export type View = { type: 'home' } | { type: 'object'; object: StoredObject } | { type: 'chat'; chat: Chat };

const ICON = { upload: Upload, clip: FileVideo, thumbnail: ImageIcon, manifest: FileJson };

export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function AppSidebar({ view, onSelect }: { view: View; onSelect: (view: View) => void }) {
  // Objects and chats change while a job runs, so both refresh on a short interval.
  const { data: objects } = useSWR<{ data: ObjectGroup[] }>('/api/objects', fetcher, { refreshInterval: 5000 });
  const { data: chats } = useSWR<{ data: Chat[] }>('/api/chats', fetcher, { refreshInterval: 5000 });

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={view.type === 'home'} onClick={() => onSelect({ type: 'home' })}>
              <Plus />
              <span>Upload a video</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Objects in the bucket</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {objects?.data.length === 0 && <p className="px-2 text-xs text-muted-foreground">Nothing uploaded yet.</p>}
              {objects?.data.map((group, index) => (
                <Collapsible key={group.job.id} defaultOpen={index === 0} className="group/collapsible">
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton title={group.job.filename}>
                        <ChevronRight className="transition-transform group-data-[state=open]/collapsible:rotate-90" />
                        <span className="truncate">{group.job.filename}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{group.objects.length}</span>
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {group.objects.map((object) => {
                          const Icon = ICON[object.kind];
                          return (
                            <SidebarMenuSubItem key={object.key}>
                              <SidebarMenuSubButton
                                isActive={view.type === 'object' && view.object.key === object.key}
                                onClick={() => onSelect({ type: 'object', object })}
                                title={object.key}
                              >
                                <Icon />
                                <span className="truncate">{object.kind === 'upload' ? 'original' : object.name}</span>
                                <span className="ml-auto text-xs text-muted-foreground">{formatSize(object.size)}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Agent chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {chats?.data.length === 0 && <p className="px-2 text-xs text-muted-foreground">Your agent hasn't worked on anything yet.</p>}
              {chats?.data.map((chat) => (
                <SidebarMenuItem key={chat.id}>
                  <SidebarMenuButton
                    className="h-auto py-1.5"
                    isActive={view.type === 'chat' && view.chat.id === chat.id}
                    onClick={() => onSelect({ type: 'chat', chat })}
                  >
                    <MessageSquare className="self-start mt-0.5" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{chat.title}</span>
                      <span className="truncate text-xs text-muted-foreground">{chat.filename}</span>
                    </span>
                    {chat.status === 'processing' && (
                      <Badge variant="outline" className="ml-auto text-blue-700">
                        live
                      </Badge>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
