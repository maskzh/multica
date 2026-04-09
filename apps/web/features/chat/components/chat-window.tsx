"use client";

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Minus, Maximize2, Send, ChevronDown, Bot } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@multica/ui/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { chatMessagesOptions, chatKeys } from "@/core/chat/queries";
import {
  useCreateChatSession,
  useSendChatMessage,
} from "@/core/chat/mutations";
import { useChatStore } from "../store";
import { ChatMessageList } from "./chat-message-list";
import { ChatInput } from "./chat-input";
import { useWS } from "@multica/core/realtime";
import type { TaskMessagePayload, ChatDonePayload, Agent } from "@multica/core/types";

export function ChatWindow() {
  const wsId = useWorkspaceId();
  const isOpen = useChatStore((s) => s.isOpen);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const pendingTaskId = useChatStore((s) => s.pendingTaskId);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const setOpen = useChatStore((s) => s.setOpen);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const setPendingTask = useChatStore((s) => s.setPendingTask);
  const appendStreaming = useChatStore((s) => s.appendStreamingContent);
  const clearStreaming = useChatStore((s) => s.clearStreamingContent);
  const setSelectedAgentId = useChatStore((s) => s.setSelectedAgentId);

  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: messages = [] } = useQuery(
    chatMessagesOptions(activeSessionId ?? ""),
  );

  const qc = useQueryClient();
  const createSession = useCreateChatSession();
  const sendMessage = useSendChatMessage(activeSessionId ?? "");

  const availableAgents = agents.filter((a) => !a.archived_at);

  // Resolve selected agent: stored preference → first available
  const activeAgent =
    availableAgents.find((a) => a.id === selectedAgentId) ??
    availableAgents[0] ??
    null;

  // Subscribe to task:message for streaming.
  const { subscribe } = useWS();

  useEffect(() => {
    if (!pendingTaskId) return;

    const unsubMessage = subscribe("task:message", (payload) => {
      const p = payload as TaskMessagePayload;
      if (p.task_id !== pendingTaskId) return;
      if (p.type === "text" && p.content) {
        appendStreaming(p.content);
      }
    });

    const unsubDone = subscribe("chat:done", (payload) => {
      const p = payload as ChatDonePayload;
      if (p.task_id !== pendingTaskId) return;
      const content = useChatStore.getState().streamingContent;
      if (content && activeSessionId) {
        qc.invalidateQueries({
          queryKey: chatKeys.messages(activeSessionId),
        });
      }
      clearStreaming();
      setPendingTask(null);
    });

    const unsubCompleted = subscribe("task:completed", (payload) => {
      const p = payload as { task_id: string };
      if (p.task_id !== pendingTaskId) return;
      if (activeSessionId) {
        qc.invalidateQueries({
          queryKey: chatKeys.messages(activeSessionId),
        });
      }
      clearStreaming();
      setPendingTask(null);
    });

    const unsubFailed = subscribe("task:failed", (payload) => {
      const p = payload as { task_id: string };
      if (p.task_id !== pendingTaskId) return;
      clearStreaming();
      setPendingTask(null);
    });

    return () => {
      unsubMessage();
      unsubDone();
      unsubCompleted();
      unsubFailed();
    };
  }, [
    pendingTaskId,
    activeSessionId,
    subscribe,
    appendStreaming,
    clearStreaming,
    setPendingTask,
    qc,
  ]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!activeAgent) return;

      let sessionId = activeSessionId;

      if (!sessionId) {
        const session = await createSession.mutateAsync({
          agent_id: activeAgent.id,
          title: content.slice(0, 50),
        });
        sessionId = session.id;
        setActiveSession(sessionId);
      }

      const { task_id } = await (await import("@/platform/api")).api.sendChatMessage(
        sessionId,
        content,
      );
      qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
      setPendingTask(task_id);
      clearStreaming();
    },
    [
      activeSessionId,
      activeAgent,
      createSession,
      setActiveSession,
      setPendingTask,
      clearStreaming,
      qc,
    ],
  );

  const handleSelectAgent = useCallback(
    (agent: Agent) => {
      setSelectedAgentId(agent.id);
      // Reset session when switching agent
      setActiveSession(null);
    },
    [setSelectedAgentId, setActiveSession],
  );

  if (!isOpen) return null;

  const hasMessages = messages.length > 0 || !!streamingContent;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col w-[420px] h-[600px] rounded-xl border bg-background shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <AgentSelector
          agents={availableAgents}
          activeAgent={activeAgent}
          onSelect={handleSelectAgent}
        />
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setOpen(false)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Maximize2 className="size-3.5" />
          </button>
          <button
            onClick={() => {
              setOpen(false);
              setActiveSession(null);
            }}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Messages or Empty State */}
      {hasMessages ? (
        <ChatMessageList
          messages={messages}
          agent={activeAgent}
          streamingContent={streamingContent}
          isWaiting={!!pendingTaskId}
        />
      ) : (
        <EmptyState agentName={activeAgent?.name} />
      )}

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={!!pendingTaskId} />
    </div>
  );
}

function AgentSelector({
  agents,
  activeAgent,
  onSelect,
}: {
  agents: Agent[];
  activeAgent: Agent | null;
  onSelect: (agent: Agent) => void;
}) {
  if (!activeAgent) {
    return <span className="text-sm text-muted-foreground">No agents</span>;
  }

  if (agents.length <= 1) {
    return (
      <div className="flex items-center gap-2">
        <AgentAvatarSmall agent={activeAgent} />
        <span className="text-sm font-medium">{activeAgent.name}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-1.5 py-1 -ml-1.5 transition-colors hover:bg-accent">
        <AgentAvatarSmall agent={activeAgent} />
        <span className="text-sm font-medium">{activeAgent.name}</span>
        <ChevronDown className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            onClick={() => onSelect(agent)}
            className="flex items-center gap-2"
          >
            <AgentAvatarSmall agent={agent} />
            <span>{agent.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentAvatarSmall({ agent }: { agent: Agent }) {
  return (
    <Avatar className="size-5">
      {agent.avatar_url && <AvatarImage src={agent.avatar_url} />}
      <AvatarFallback className="bg-purple-100 text-purple-700 text-[10px]">
        <Bot className="size-3" />
      </AvatarFallback>
    </Avatar>
  );
}

function EmptyState({ agentName }: { agentName?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
      <Send className="size-8 text-muted-foreground/50" />
      <div className="text-center">
        <h3 className="text-base font-semibold">Welcome to Multica</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {agentName
            ? `Chat with ${agentName} or ask anything`
            : "Ask anything or tell Multica what you need"}
        </p>
      </div>
    </div>
  );
}
