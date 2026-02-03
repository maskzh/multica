import { ipcRenderer, contextBridge } from 'electron'

// ============================================================================
// Type definitions for IPC API
// ============================================================================

export interface HubStatus {
  hubId: string
  status: string
  agentCount: number
  gatewayConnected: boolean
  gatewayUrl?: string
  defaultAgent?: {
    agentId: string
    status: string
  } | null
}

export interface AgentInfo {
  agentId: string
  status: string
}

export interface ToolInfo {
  name: string
  group: string
  enabled: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  source: 'bundled' | 'global' | 'profile'
  triggers: string[]
}

// ============================================================================
// Expose typed API to Renderer process
// ============================================================================

const electronAPI = {
  // Hub management
  hub: {
    init: () => ipcRenderer.invoke('hub:init'),
    getStatus: (): Promise<HubStatus> => ipcRenderer.invoke('hub:getStatus'),
    getAgentInfo: (): Promise<AgentInfo | null> => ipcRenderer.invoke('hub:getAgentInfo'),
    info: () => ipcRenderer.invoke('hub:info'),
    reconnect: (url: string) => ipcRenderer.invoke('hub:reconnect', url),
    listAgents: () => ipcRenderer.invoke('hub:listAgents'),
    createAgent: (id?: string) => ipcRenderer.invoke('hub:createAgent', id),
    getAgent: (id: string) => ipcRenderer.invoke('hub:getAgent', id),
    closeAgent: (id: string) => ipcRenderer.invoke('hub:closeAgent', id),
    sendMessage: (agentId: string, content: string) =>
      ipcRenderer.invoke('hub:sendMessage', agentId, content),
  },

  // Tools management
  tools: {
    list: (): Promise<ToolInfo[]> => ipcRenderer.invoke('tools:list'),
    toggle: (name: string) => ipcRenderer.invoke('tools:toggle', name),
    setStatus: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('tools:setStatus', name, enabled),
    active: () => ipcRenderer.invoke('tools:active'),
    reload: () => ipcRenderer.invoke('tools:reload'),
  },

  // Skills management
  skills: {
    list: (): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list'),
    get: (id: string) => ipcRenderer.invoke('skills:get', id),
    toggle: (id: string) => ipcRenderer.invoke('skills:toggle', id),
    setStatus: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:setStatus', id, enabled),
    reload: () => ipcRenderer.invoke('skills:reload'),
    add: (source: string, options?: { name?: string; force?: boolean }) =>
      ipcRenderer.invoke('skills:add', source, options),
    remove: (name: string) => ipcRenderer.invoke('skills:remove', name),
  },

  // Agent management
  agent: {
    status: () => ipcRenderer.invoke('agent:status'),
  },
}

// Expose to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Also expose ipcRenderer for backward compatibility
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

// Type declaration for window object
export type ElectronAPI = typeof electronAPI
