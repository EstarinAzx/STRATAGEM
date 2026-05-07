import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import {
  SCHEDULE_WAKEUP_MAX_SECONDS,
  SCHEDULE_WAKEUP_MIN_SECONDS,
  SCHEDULE_WAKEUP_TOOL_NAME,
} from '../../tools/ScheduleWakeupTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

type LoopMode =
  | 'dynamic-prompt'
  | 'dynamic-maintenance'
  | 'fixed-prompt'
  | 'fixed-maintenance'

type ParsedLoopArgs = {
  mode: LoopMode
  interval?: string
  prompt?: string
}


const MAINTENANCE_PROMPT = `Scheduled maintenance loop iteration.

If .claude/loop.md exists, read it and follow it.
Otherwise, if ~/.claude/loop.md exists, read it and follow it.
Otherwise:
- continue any unfinished work from the conversation
- tend to the current branch's pull request: review comments, failed CI runs, merge conflicts
- run cleanup passes such as bug hunts or simplification when nothing else is pending

Do not start new initiatives outside that scope.
Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized.`

function normalizeIntervalUnit(rawUnit: string): 's' | 'm' | 'h' | 'd' | null {
  const unit = rawUnit.toLowerCase()
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) return 's'
  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) return 'm'
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) return 'h'
  if (['d', 'day', 'days'].includes(unit)) return 'd'
  return null
}

function parseIntervalToken(token: string): string | null {
  const match = token.trim().match(/^(\d+)\s*([a-zA-Z]+)$/)
  if (!match) return null
  const value = Number.parseInt(match[1]!, 10)
  if (!Number.isFinite(value) || value < 1) return null
  const unit = normalizeIntervalUnit(match[2]!)
  if (!unit) return null
  return `${value}${unit}`
}

function parseTrailingEveryClause(input: string): {
  prompt: string
  interval: string
} | null {
  const match = input.match(/^(.*?)(?:\s+every\s+)(\d+)\s*([a-zA-Z]+)\s*$/i)
  if (!match) return null
  const interval = parseIntervalToken(`${match[2]!}${match[3]!}`)
  if (!interval) return null
  return {
    prompt: match[1]!.trim(),
    interval,
  }
}

function parseLoopArgs(args: string): ParsedLoopArgs {
  const trimmed = args.trim()
  if (!trimmed) return { mode: 'dynamic-maintenance' }

  const bareInterval = parseIntervalToken(trimmed)
  if (bareInterval) {
    return { mode: 'fixed-maintenance', interval: bareInterval }
  }

  const [firstToken, ...restTokens] = trimmed.split(/\s+/)
  const leadingInterval = parseIntervalToken(firstToken ?? '')
  if (leadingInterval) {
    const prompt = restTokens.join(' ').trim()
    if (!prompt) return { mode: 'fixed-maintenance', interval: leadingInterval }
    return {
      mode: 'fixed-prompt',
      interval: leadingInterval,
      prompt,
    }
  }

  const trailingEvery = parseTrailingEveryClause(trimmed)
  if (trailingEvery) {
    if (!trailingEvery.prompt) {
      return {
        mode: 'fixed-maintenance',
        interval: trailingEvery.interval,
      }
    }
    return {
      mode: 'fixed-prompt',
      interval: trailingEvery.interval,
      prompt: trailingEvery.prompt,
    }
  }

  return {
    mode: 'dynamic-prompt',
    prompt: trimmed,
  }
}

function buildFixedPrompt(parsed: ParsedLoopArgs): string {
  const targetInstructions = parsed.prompt
    ? `Use this prompt verbatim for both the immediate run and the recurring scheduled task:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

For the recurring scheduled task, use this exact maintenance prompt body:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`

  return `# /loop — fixed recurring interval

The user invoked /loop with a fixed interval.

Requested interval: ${parsed.interval}

${targetInstructions}
## Instructions

1. Convert the requested interval to a recurring cron expression.
   - Supported suffixes: s, m, h, d.
   - Seconds must be rounded up to the nearest minute because cron has minute granularity.
   - If the requested interval does not map cleanly to cron cadence, choose the nearest clean recurring interval and tell the user what you picked.
2. Call ${CRON_CREATE_TOOL_NAME} with:
   - the recurring cron expression
   - the effective prompt body above
   - recurring: true
   - durable: false
3. Briefly confirm what was scheduled, the cron expression, the human cadence, that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days, and that the user can cancel sooner with ${CRON_DELETE_TOOL_NAME} using the returned job ID.
4. Immediately execute the effective prompt now — do not wait for the first cron fire.
   - If the effective prompt starts with a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
`
}

function buildDynamicPrompt(parsed: ParsedLoopArgs): string {
  const effectivePromptInstructions = parsed.prompt
    ? `Use this prompt verbatim as the effective prompt for this iteration:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

Determine the effective prompt in this order:
1. If .claude/loop.md exists, read it and use it.
2. Otherwise, if ~/.claude/loop.md exists, read it and use it.
3. Otherwise, use this built-in maintenance prompt:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`

  const reschedulePrompt = parsed.prompt ? `/loop ${parsed.prompt}` : '/loop'

  return `# /loop — dynamic rescheduling

The user invoked /loop without a fixed interval.

${effectivePromptInstructions}
## Instructions

1. Execute the effective prompt now.
   - If it starts with a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
2. After the work finishes, choose the next delay dynamically in [${SCHEDULE_WAKEUP_MIN_SECONDS}, ${SCHEDULE_WAKEUP_MAX_SECONDS}] seconds.
   - Think in cache windows, not round-number minutes. The prompt cache TTL is 5 minutes — picking exactly 300s is the worst-of-both because you pay the cache miss without amortizing it.
   - Under 5 minutes (60s–270s): cache stays warm — use for active work or polling state about to change.
   - Over 5 minutes (300s–3600s): pay the cache miss — use only when there is no point checking sooner.
   - For idle ticks with no specific signal to watch, default to 1200s–1800s (20–30 min).
3. Briefly tell the user the chosen delay and the reason.
4. Schedule exactly one session-only wake-up by calling ${SCHEDULE_WAKEUP_TOOL_NAME}.
   - delaySeconds = the chosen delay (the runtime clamps to [${SCHEDULE_WAKEUP_MIN_SECONDS}, ${SCHEDULE_WAKEUP_MAX_SECONDS}]).
   - reason = the one-sentence rationale shown to the user.
   - prompt = this exact text so the next iteration stays in dynamic mode:

--- BEGIN SCHEDULED PROMPT ---
${reschedulePrompt}
--- END SCHEDULED PROMPT ---

5. Do not call ${CRON_CREATE_TOOL_NAME} for dynamic mode — ${SCHEDULE_WAKEUP_TOOL_NAME} is the purpose-built primitive.
`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt on a fixed interval or dynamically reschedule it, including bare maintenance-mode loops.',
    whenToUse:
      'When the user wants to poll for status, babysit a workflow, run recurring maintenance, or keep re-running a prompt within the current session.',
    argumentHint: '[interval] [prompt]',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const parsed = parseLoopArgs(args)
      const text =
        parsed.mode === 'fixed-prompt' || parsed.mode === 'fixed-maintenance'
          ? buildFixedPrompt(parsed)
          : buildDynamicPrompt(parsed)
      return [{ type: 'text', text }]
    },
  })
}
