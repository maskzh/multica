import { create } from "zustand";

const AGENT_STORAGE_KEY = "multica:chat:selectedAgentId";

function readStoredAgentId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AGENT_STORAGE_KEY);
}

interface ChatState {
  isOpen: boolean;
  activeSessionId: string | null;
  pendingTaskId: string | null;
  streamingContent: string;
  selectedAgentId: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setActiveSession: (id: string | null) => void;
  setPendingTask: (taskId: string | null) => void;
  appendStreamingContent: (text: string) => void;
  clearStreamingContent: () => void;
  setSelectedAgentId: (id: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  isOpen: false,
  activeSessionId: null,
  pendingTaskId: null,
  streamingContent: "",
  selectedAgentId: readStoredAgentId(),
  setOpen: (open) => set({ isOpen: open }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  setActiveSession: (id) => set({ activeSessionId: id }),
  setPendingTask: (taskId) => set({ pendingTaskId: taskId }),
  appendStreamingContent: (text) =>
    set((s) => ({ streamingContent: s.streamingContent + text })),
  clearStreamingContent: () => set({ streamingContent: "" }),
  setSelectedAgentId: (id) => {
    localStorage.setItem(AGENT_STORAGE_KEY, id);
    set({ selectedAgentId: id });
  },
}));
