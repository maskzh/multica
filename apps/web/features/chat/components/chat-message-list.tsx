"use client";

import { useEffect, useRef } from "react";
import { cn } from "@multica/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@multica/ui/components/ui/avatar";
import { Bot, Loader2 } from "lucide-react";
import type { ChatMessage, Agent } from "@multica/core/types";

interface ChatMessageListProps {
  messages: ChatMessage[];
  agent: Agent | null;
  streamingContent: string;
  isWaiting: boolean;
}

export function ChatMessageList({
  messages,
  agent,
  streamingContent,
  isWaiting,
}: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} agent={agent} />
      ))}
      {streamingContent && (
        <div className="flex items-start gap-3">
          <AgentAvatar agent={agent} />
          <div className="min-w-0 flex-1 text-sm leading-relaxed whitespace-pre-wrap">
            {streamingContent}
          </div>
        </div>
      )}
      {isWaiting && !streamingContent && (
        <div className="flex items-start gap-3">
          <AgentAvatar agent={agent} />
          <div className="flex items-center pt-1">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({
  message,
  agent,
}: {
  message: ChatMessage;
  agent: Agent | null;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="rounded-2xl bg-primary px-3.5 py-2 text-sm text-primary-foreground max-w-[85%]">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <AgentAvatar agent={agent} />
      <div className="min-w-0 flex-1 text-sm leading-relaxed whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function AgentAvatar({ agent }: { agent: Agent | null }) {
  return (
    <Avatar className="size-6 shrink-0 mt-0.5">
      {agent?.avatar_url && <AvatarImage src={agent.avatar_url} />}
      <AvatarFallback className="bg-purple-100 text-purple-700">
        <Bot className="size-3" />
      </AvatarFallback>
    </Avatar>
  );
}
