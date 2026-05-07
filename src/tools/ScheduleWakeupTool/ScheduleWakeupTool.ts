import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { addCronTask, listAllCronTasks } from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildScheduleWakeupPrompt,
  isKairosCronEnabled,
  SCHEDULE_WAKEUP_DESCRIPTION,
  SCHEDULE_WAKEUP_MAX_SECONDS,
  SCHEDULE_WAKEUP_MIN_SECONDS,
  SCHEDULE_WAKEUP_TOOL_NAME,
} from './prompt.js'
import { renderWakeupResultMessage, renderWakeupToolUseMessage } from './UI.js'

const MAX_JOBS = 50

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: z
      .number()
      .int()
      .describe(
        `Seconds from now to wake up. Clamped to [${SCHEDULE_WAKEUP_MIN_SECONDS}, ${SCHEDULE_WAKEUP_MAX_SECONDS}] by the runtime.`,
      ),
    reason: z
      .string()
      .describe(
        'One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific.',
      ),
    prompt: z
      .string()
      .describe(
        'The prompt to fire on wake-up. For /loop dynamic mode, pass the original /loop input verbatim so the next firing re-enters the skill.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    delaySeconds: z.number(),
    fireAtMs: z.number(),
    fireAtHuman: z.string(),
    reason: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type WakeupOutput = z.infer<OutputSchema>

function clampDelaySeconds(raw: number): number {
  if (!Number.isFinite(raw)) return SCHEDULE_WAKEUP_MIN_SECONDS
  const floored = Math.floor(raw)
  if (floored < SCHEDULE_WAKEUP_MIN_SECONDS) return SCHEDULE_WAKEUP_MIN_SECONDS
  if (floored > SCHEDULE_WAKEUP_MAX_SECONDS) return SCHEDULE_WAKEUP_MAX_SECONDS
  return floored
}

function buildOneShotCronFromDelay(delaySeconds: number): {
  cron: string
  fireAt: Date
} {
  const fireAt = new Date(Date.now() + delaySeconds * 1000)
  if (fireAt.getSeconds() > 0 || fireAt.getMilliseconds() > 0) {
    fireAt.setMinutes(fireAt.getMinutes() + 1)
  }
  fireAt.setSeconds(0)
  fireAt.setMilliseconds(0)
  const cron = `${fireAt.getMinutes()} ${fireAt.getHours()} ${fireAt.getDate()} ${fireAt.getMonth() + 1} *`
  return { cron, fireAt }
}

function formatFireAtHuman(fireAt: Date): string {
  const hh = String(fireAt.getHours()).padStart(2, '0')
  const mm = String(fireAt.getMinutes()).padStart(2, '0')
  return `${hh}:${mm} local`
}

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  searchHint: 'self-pace a one-shot wake-up to continue work after a delay',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.delaySeconds}s: ${input.reason}`
  },
  async description() {
    return SCHEDULE_WAKEUP_DESCRIPTION
  },
  async prompt() {
    return buildScheduleWakeupPrompt()
  },
  async validateInput(): Promise<ValidationResult> {
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first via CronDelete.`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async call({ delaySeconds, reason, prompt }) {
    const effectiveDelay = clampDelaySeconds(delaySeconds)
    const { cron, fireAt } = buildOneShotCronFromDelay(effectiveDelay)
    const id = await addCronTask(
      cron,
      prompt,
      false,
      false,
      getTeammateContext()?.agentId,
    )
    setScheduledTasksEnabled(true)
    return {
      data: {
        id,
        delaySeconds: effectiveDelay,
        fireAtMs: fireAt.getTime(),
        fireAtHuman: formatFireAtHuman(fireAt),
        reason,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Wake-up ${output.id} scheduled in ${output.delaySeconds}s (${output.fireAtHuman}). Reason: ${output.reason}. Session-only one-shot — fires once then auto-deletes.`,
    }
  },
  renderToolUseMessage: renderWakeupToolUseMessage,
  renderToolResultMessage: renderWakeupResultMessage,
} satisfies ToolDef<InputSchema, WakeupOutput>)
