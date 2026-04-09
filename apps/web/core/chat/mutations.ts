import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/platform/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { chatKeys } from "./queries";
import type { ChatMessage } from "@multica/core/types";

export function useCreateChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (data: { agent_id: string; title?: string }) =>
      api.createChatSession(data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
    },
  });
}

export function useArchiveChatSession() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation({
    mutationFn: (sessionId: string) => api.archiveChatSession(sessionId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
    },
  });
}

export function useSendChatMessage(sessionId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (content: string) => api.sendChatMessage(sessionId, content),
    onMutate: async (content) => {
      await qc.cancelQueries({ queryKey: chatKeys.messages(sessionId) });
      const prev = qc.getQueryData<ChatMessage[]>(chatKeys.messages(sessionId));

      // Optimistic: add user message immediately.
      const optimistic: ChatMessage = {
        id: `optimistic-${Date.now()}`,
        chat_session_id: sessionId,
        role: "user",
        content,
        task_id: null,
        created_at: new Date().toISOString(),
      };
      qc.setQueryData<ChatMessage[]>(chatKeys.messages(sessionId), (old) =>
        old ? [...old, optimistic] : [optimistic],
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(chatKeys.messages(sessionId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
    },
  });
}
