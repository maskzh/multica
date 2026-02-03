/**
 * Skills IPC handlers for Electron main process.
 *
 * These handlers get skill information from the real Agent instance
 * managed by the Hub.
 */
import { ipcMain } from 'electron'
import { getCurrentHub } from './hub.js'

/**
 * Skill info returned to renderer.
 */
export interface SkillInfo {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  source: 'bundled' | 'global' | 'profile'
  triggers: string[]
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
 * Get default bundled skills (fallback when no agent).
 */
function getDefaultSkills(): SkillInfo[] {
  return [
    {
      id: 'commit',
      name: 'Git Commit Helper',
      description: 'Create well-formatted git commits following conventional commit standards',
      version: '1.0.0',
      enabled: true,
      source: 'bundled',
      triggers: ['/commit'],
    },
    {
      id: 'code-review',
      name: 'Code Review',
      description: 'Review code for bugs, security issues, and best practices',
      version: '1.0.0',
      enabled: true,
      source: 'bundled',
      triggers: ['/review'],
    },
    {
      id: 'skill-creator',
      name: 'Skill Creator',
      description: 'Create, edit, and manage custom skills',
      version: '1.0.0',
      enabled: true,
      source: 'bundled',
      triggers: ['/skill'],
    },
    {
      id: 'profile-setup',
      name: 'Profile Setup',
      description: 'Interactive setup wizard to personalize your agent profile',
      version: '1.0.0',
      enabled: true,
      source: 'bundled',
      triggers: ['/profile'],
    },
  ]
}

/**
 * Register all Skills-related IPC handlers.
 */
export function registerSkillsIpcHandlers(): void {
  /**
   * Get list of all skills with their status.
   * Returns skills from the real Agent instance.
   */
  ipcMain.handle('skills:list', async () => {
    const agent = getDefaultAgent()

    if (!agent) {
      // Fallback: return default skills when no agent
      console.log('[IPC] skills:list - No agent available, returning defaults')
      return getDefaultSkills()
    }

    try {
      const skillsWithStatus = agent.getSkillsWithStatus()

      // Transform to SkillInfo format
      const skills: SkillInfo[] = skillsWithStatus.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: '1.0.0', // Skills don't have version in current implementation
        enabled: skill.eligible,
        source: skill.source as 'bundled' | 'global' | 'profile',
        triggers: [`/${skill.id}`], // Default trigger is /<skill-id>
      }))

      console.log(`[IPC] skills:list - Returning ${skills.length} skills from agent`)
      return skills
    } catch (err) {
      console.error('[IPC] skills:list - Error getting skills from agent:', err)
      return getDefaultSkills()
    }
  })

  /**
   * Toggle a skill's enabled status.
   * NOTE: Skills eligibility is determined by requirements (env vars, binaries, etc.)
   * This handler reports the current eligibility status.
   */
  ipcMain.handle('skills:toggle', async (_event, skillId: string) => {
    console.log(`[IPC] skills:toggle called for: ${skillId}`)

    const agent = getDefaultAgent()
    if (!agent) {
      return { error: 'No agent available' }
    }

    const skillsWithStatus = agent.getSkillsWithStatus()
    const skill = skillsWithStatus.find((s) => s.id === skillId)

    if (!skill) {
      return { error: `Skill not found: ${skillId}` }
    }

    // Skills can't be manually toggled - eligibility is based on requirements
    // Return current status
    return {
      id: skillId,
      enabled: skill.eligible,
      reasons: skill.reasons,
    }
  })

  /**
   * Set a skill's enabled status explicitly.
   * NOTE: Skills eligibility is automatic based on requirements.
   * This handler is a no-op but returns current status.
   */
  ipcMain.handle('skills:setStatus', async (_event, skillId: string, enabled: boolean) => {
    console.log(`[IPC] skills:setStatus called for: ${skillId}, enabled: ${enabled}`)

    const agent = getDefaultAgent()
    if (!agent) {
      return { error: 'No agent available' }
    }

    const skillsWithStatus = agent.getSkillsWithStatus()
    const skill = skillsWithStatus.find((s) => s.id === skillId)

    if (!skill) {
      return { error: `Skill not found: ${skillId}` }
    }

    // TODO: Implement skill disable via config
    // For now, just return current eligibility status
    return {
      id: skillId,
      enabled: skill.eligible,
      reasons: skill.reasons,
    }
  })

  /**
   * Get skill details by ID.
   */
  ipcMain.handle('skills:get', async (_event, skillId: string) => {
    const agent = getDefaultAgent()

    if (!agent) {
      // Fallback: check default skills
      const defaults = getDefaultSkills()
      const skill = defaults.find((s) => s.id === skillId)
      if (skill) return skill
      return { error: `Skill not found: ${skillId}` }
    }

    const skillsWithStatus = agent.getSkillsWithStatus()
    const skill = skillsWithStatus.find((s) => s.id === skillId)

    if (!skill) {
      return { error: `Skill not found: ${skillId}` }
    }

    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: '1.0.0',
      enabled: skill.eligible,
      source: skill.source as 'bundled' | 'global' | 'profile',
      triggers: [`/${skill.id}`],
      reasons: skill.reasons,
    }
  })

  /**
   * Reload skills from disk.
   */
  ipcMain.handle('skills:reload', async () => {
    const agent = getDefaultAgent()
    if (!agent) {
      return { error: 'No agent available' }
    }

    agent.reloadSkills()
    console.log('[IPC] skills:reload - Skills reloaded')

    return { ok: true }
  })

  /**
   * Add a skill from GitHub repository.
   * Source formats: owner/repo, owner/repo/skill-name, or full GitHub URL
   */
  ipcMain.handle(
    'skills:add',
    async (
      _event,
      source: string,
      options?: { name?: string; force?: boolean },
    ) => {
      console.log(`[IPC] skills:add called: source=${source}, options=${JSON.stringify(options)}`)

      const { addSkill } = await import('../../../../src/agent/skills/add.js')

      const result = await addSkill({
        source,
        name: options?.name,
        force: options?.force,
      })

      console.log(`[IPC] skills:add result: ${result.message}`)

      // Reload skills in agent if available
      const agent = getDefaultAgent()
      if (agent && result.ok) {
        agent.reloadSkills()
      }

      return result
    },
  )

  /**
   * Remove an installed skill by name.
   */
  ipcMain.handle('skills:remove', async (_event, name: string) => {
    console.log(`[IPC] skills:remove called: name=${name}`)

    const { removeSkill } = await import('../../../../src/agent/skills/add.js')

    const result = await removeSkill(name)

    console.log(`[IPC] skills:remove result: ${result.message}`)

    // Reload skills in agent if available
    const agent = getDefaultAgent()
    if (agent && result.ok) {
      agent.reloadSkills()
    }

    return result
  })
}
