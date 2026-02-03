/**
 * Agent IPC handlers for Electron main process.
 *
 * These handlers get tool information from the real Agent instance
 * managed by the Hub.
 */
import { ipcMain } from 'electron'
import { getCurrentHub } from './hub.js'

// Tool groups (for UI display grouping)
const TOOL_GROUPS: Record<string, string[]> = {
  'group:fs': ['read', 'write', 'edit', 'glob'],
  'group:runtime': ['exec', 'process'],
  'group:web': ['web_search', 'web_fetch'],
  'group:memory': ['memory_get', 'memory_set', 'memory_delete', 'memory_list'],
}

// All known tool names (for display when agent not available)
const ALL_KNOWN_TOOLS = [
  ...TOOL_GROUPS['group:fs'],
  ...TOOL_GROUPS['group:runtime'],
  ...TOOL_GROUPS['group:web'],
  ...TOOL_GROUPS['group:memory'],
]

/**
 * Get the group for a tool name.
 */
function getToolGroup(name: string): string {
  for (const [groupKey, tools] of Object.entries(TOOL_GROUPS)) {
    const groupId = groupKey.replace('group:', '')
    if (tools.includes(name)) {
      return groupId
    }
  }
  return 'other'
}

/**
 * Get the default agent from Hub.
 */
function getDefaultAgent() {
  const hub = getCurrentHub()
  if (!hub) return null

  const agentIds = hub.listAgents()
  if (agentIds.length === 0) return null

  return hub.getAgent(agentIds[0]) ?? null
}

/**
 * Register all Agent-related IPC handlers.
 */
export function registerAgentIpcHandlers(): void {
  // ============================================================================
  // Agent lifecycle
  // ============================================================================

  /**
   * Get agent status
   */
  ipcMain.handle('agent:status', async () => {
    const agent = getDefaultAgent()
    if (!agent) {
      return {
        running: false,
        error: 'No agent available',
      }
    }

    return {
      running: !agent.closed,
      agentId: agent.sessionId,
    }
  })

  // ============================================================================
  // Tools management
  // ============================================================================

  /**
   * Get list of all tools with their enabled status.
   * Returns active tools from the real Agent instance.
   */
  ipcMain.handle('tools:list', async () => {
    const agent = getDefaultAgent()

    if (!agent) {
      // Fallback: return all known tools as disabled when no agent
      return ALL_KNOWN_TOOLS.map((name) => ({
        name,
        enabled: false,
        group: getToolGroup(name),
      }))
    }

    // Get active tools from agent
    const activeTools = agent.getActiveTools()
    const activeSet = new Set(activeTools)

    // Build list with all known tools, marking which are active
    const toolList = ALL_KNOWN_TOOLS.map((name) => ({
      name,
      enabled: activeSet.has(name),
      group: getToolGroup(name),
    }))

    // Add any active tools not in our known list
    for (const name of activeTools) {
      if (!ALL_KNOWN_TOOLS.includes(name)) {
        toolList.push({
          name,
          enabled: true,
          group: getToolGroup(name),
        })
      }
    }

    return toolList
  })

  /**
   * Toggle a tool's enabled status.
   * Persists the change to profile config and reloads tools.
   */
  ipcMain.handle('tools:toggle', async (_event, toolName: string) => {
    console.log(`[IPC] tools:toggle called for: ${toolName}`)

    const agent = getDefaultAgent()
    if (!agent) {
      return { error: 'No agent available' }
    }

    // Check current status
    const activeTools = agent.getActiveTools()
    const isCurrentlyEnabled = activeTools.includes(toolName)

    // Toggle the tool status (enable if disabled, disable if enabled)
    const result = agent.setToolStatus(toolName, !isCurrentlyEnabled)
    if (!result) {
      return { error: 'No profile loaded - cannot persist tool status' }
    }

    // Get updated status
    const newActiveTools = agent.getActiveTools()
    const isNowEnabled = newActiveTools.includes(toolName)
    console.log(`[IPC] Tool ${toolName} toggled: ${isCurrentlyEnabled} -> ${isNowEnabled}`)

    return {
      name: toolName,
      enabled: isNowEnabled,
    }
  })

  /**
   * Set a tool's enabled status explicitly.
   * Persists the change to profile config and reloads tools.
   */
  ipcMain.handle('tools:setStatus', async (_event, toolName: string, enabled: boolean) => {
    console.log(`[IPC] tools:setStatus called for: ${toolName}, enabled: ${enabled}`)

    const agent = getDefaultAgent()
    if (!agent) {
      return { error: 'No agent available' }
    }

    // Set the tool status and persist to profile config
    const result = agent.setToolStatus(toolName, enabled)
    if (!result) {
      return { error: 'No profile loaded - cannot persist tool status' }
    }

    console.log(`[IPC] Tool ${toolName} status set to ${enabled}. Config: allow=${result.allow?.join(',') ?? 'none'}, deny=${result.deny?.join(',') ?? 'none'}`)

    // Get updated status
    const activeTools = agent.getActiveTools()
    const isEnabled = activeTools.includes(toolName)

    return {
      name: toolName,
      enabled: isEnabled,
      config: result,
    }
  })

  /**
   * Get currently active tools in the agent.
   */
  ipcMain.handle('tools:active', async () => {
    const agent = getDefaultAgent()
    if (!agent) {
      return []
    }
    return agent.getActiveTools()
  })

  /**
   * Force reload tools in the agent.
   * This picks up any changes made to credentials.json5.
   */
  ipcMain.handle('tools:reload', async () => {
    const agent = getDefaultAgent()
    if (!agent) {
      return { error: 'No agent available' }
    }

    const reloadedTools = agent.reloadTools()
    console.log(`[IPC] Reloaded ${reloadedTools.length} tools: ${reloadedTools.join(', ')}`)

    return reloadedTools
  })
}

/**
 * Cleanup agent resources.
 */
export function cleanupAgent(): void {
  // Agent cleanup is handled by Hub
}
