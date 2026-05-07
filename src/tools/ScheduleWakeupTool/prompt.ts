import { isKairosCronEnabled } from '../ScheduleCronTool/prompt.js'

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'

export const SCHEDULE_WAKEUP_DESCRIPTION =
  'Schedule a single self-paced wake-up to continue work after a delay. Use for dynamic /loop pacing — pick the next wake based on what you are waiting for, not a round-number minute.'

export const SCHEDULE_WAKEUP_MIN_SECONDS = 60
export const SCHEDULE_WAKEUP_MAX_SECONDS = 3600

export function buildScheduleWakeupPrompt(): string {
  return `Schedule a single one-shot wake-up to continue work after \`delaySeconds\`. The runtime fires the supplied \`prompt\` exactly once at that time, then forgets the wake. Omit the call to end the loop.

For ongoing /loop dynamic mode, pass the same /loop input back via \`prompt\` each turn so the next firing repeats the task. For an autonomous loop with no user prompt, pass the literal sentinel \`<<autonomous-loop-dynamic>>\` as \`prompt\` — the runtime resolves it back to the autonomous-loop instructions at fire time.

## Picking delaySeconds

The Anthropic prompt cache has a 5-minute TTL. Sleeping past 300 seconds means the next wake-up reads your full conversation context uncached — slower and more expensive. Natural breakpoints:

- **Under 5 minutes (60s–270s)**: cache stays warm. Right for active work — checking a build, polling for state about to change, watching a process you started.
- **5 minutes to 1 hour (300s–3600s)**: pay the cache miss. Right when there's no point checking sooner — waiting on something that takes minutes to change, or genuinely idle.

**Don't pick exactly 300s.** Worst-of-both: cache miss without amortizing it. If tempted to "wait 5 minutes," either drop to 270s (stay in cache) or commit to 1200s+ (one cache miss buys a much longer wait). Don't think in round-number minutes — think in cache windows.

For idle ticks with no specific signal to watch, default to **1200s–1800s** (20–30 min). The loop checks back, you don't burn cache 12× per hour for nothing, and the user can interrupt if they need you sooner.

Think about what you are actually waiting for, not just "how long should I sleep." If you kicked off an 8-minute build, sleeping 60s burns the cache 8 times before it finishes — sleep ~270s twice instead.

The runtime clamps to [${SCHEDULE_WAKEUP_MIN_SECONDS}, ${SCHEDULE_WAKEUP_MAX_SECONDS}], so you do not need to clamp yourself.

## The reason field

One short sentence on what was chosen and why. Goes to telemetry and is shown back to the user. "checking long bun build" beats "waiting." The user reads this to understand what you are doing without having to predict your cadence in advance — be specific.

## Runtime notes

- The wake-up is session-only and one-shot — it dies with this session and never recurs.
- Scheduler granularity is 1 minute; the actual fire may be up to ~60s later than the requested delay. This is fine for self-pacing and matches the cache-window thresholds above.
- If you want a recurring schedule instead, use CronCreate with \`recurring: true\`.`
}

export { isKairosCronEnabled }
