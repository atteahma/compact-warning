import { expect, test } from 'claude-code/testing'
import type { AgentInfo, AgentStatus } from 'claude-code'

import {
  MAX_INSTRUCTIONS,
  MAX_NAMED,
  ageOf,
  cleanInstructions,
  compactLine,
  configOf,
  endedIn,
  gaugeOf,
  greetingText,
  hasShrunk,
  healthText,
  instructionsFor,
  isStronger,
  isUnfinished,
  levelOf,
  nudgeText,
  readyHint,
  readyText,
  refusalOf,
  reportText,
  runningOf,
  runningText,
  statusText,
  stoppedOf,
  storedText,
  taskOf,
  thresholdsOf,
  toastText,
  tokensText,
  unfinishedOf,
} from '../hooks/logic'
import type { Report, Task } from '../hooks/logic'

/** The auto-compaction point of a 1M window, and of a 200k window. */
const LARGE = 967_000
const SMALL = 167_000

test('the options default to 80% and 88%, a reserve of 30 000 tokens, attended', () => {
  expect(configOf({})).toEqual({
    warnPercent: 80,
    stopPercent: 88,
    warnTokens: 0,
    stopTokens: 0,
    reserveTokens: 30_000,
    isUnattended: false,
  })
})

test('an option outside its range is pulled back in', () => {
  const config = configOf({
    warnPercent: 0,
    stopPercent: 250,
    warnTokens: -5,
    stopTokens: 300_000.4,
    reserveTokens: 'many',
    unattended: true,
  })

  expect(config).toEqual({
    warnPercent: 1,
    stopPercent: 99,
    warnTokens: 0,
    stopTokens: 300_000,
    reserveTokens: 30_000,
    isUnattended: true,
  })
})

test('on a large window the nudges come at their percentages', () => {
  expect(thresholdsOf(LARGE, configOf({}))).toEqual({ warn: 773_600, stop: 850_960 })
})

test('on a small window both nudges come earlier, and the reserve remains', () => {
  // 88% would leave 20 040 tokens. Both nudges move 9 960 tokens earlier.
  expect(thresholdsOf(SMALL, configOf({}))).toEqual({ warn: 123_640, stop: 137_000 })
  expect(thresholdsOf(SMALL, configOf({ reserveTokens: 0 }))).toEqual({
    warn: 133_600,
    stop: 146_960,
  })
  // The reserve takes a quarter of the limit at most.
  expect(thresholdsOf(60_000, configOf({})).stop).toBe(45_000)
})

test('a token count gives a nudge when it comes before the percentage', () => {
  const config = configOf({ warnTokens: 250_000, stopTokens: 300_000 })

  expect(thresholdsOf(LARGE, config)).toEqual({ warn: 250_000, stop: 300_000 })
  // Past the small window's own nudges, the token counts change nothing.
  expect(thresholdsOf(SMALL, config)).toEqual({ warn: 123_640, stop: 137_000 })
})

test('the first nudge never comes after the second', () => {
  expect(thresholdsOf(LARGE, configOf({ stopTokens: 300_000 }))).toEqual({
    warn: 300_000,
    stop: 300_000,
  })
  expect(thresholdsOf(LARGE, configOf({ warnPercent: 90, stopPercent: 70 }))).toEqual({
    warn: 676_900,
    stop: 676_900,
  })
})

test('the level follows the nudges', () => {
  const thresholds = thresholdsOf(LARGE, configOf({}))

  expect(levelOf(773_599, thresholds)).toBe('none')
  expect(levelOf(773_600, thresholds)).toBe('warn')
  expect(levelOf(850_959, thresholds)).toBe('warn')
  expect(levelOf(850_960, thresholds)).toBe('stop')
  expect(isStronger('stop', 'warn')).toBe(true)
  expect(isStronger('warn', 'warn')).toBe(false)
  // Shrunk: five percent of the limit under the first nudge.
  expect(hasShrunk(gaugeOf(725_249, LARGE), thresholds)).toBe(true)
  expect(hasShrunk(gaugeOf(725_250, LARGE), thresholds)).toBe(false)
})

test('the gauge is a whole percentage of the limit', () => {
  expect(gaugeOf(773_600, LARGE)).toEqual({
    tokens: 773_600,
    limit: LARGE,
    percent: 80,
    isAutoCompact: true,
  })
  expect(gaugeOf(10, 0).percent).toBe(1000)
})

test('a token count is written as Claude Code writes one', () => {
  expect(tokensText(850)).toBe('850')
  expect(tokensText(18_400)).toBe('18k')
  expect(tokensText(773_600)).toBe('774k')
  expect(tokensText(999_600)).toBe('1M')
  expect(tokensText(1_250_000)).toBe('1.25M')
})

test('the nudge names the fill and the tool', () => {
  const text = nudgeText('warn', gaugeOf(773_600, LARGE), false)

  expect(text).toContain(
    '[compact-warning] The context is at 80% of the point where auto-compaction fires (774k of 967k tokens). Keep working, and look for a good breakpoint.',
  )
  expect(text).toContain('mcp__compact-warning__propose_compact')
  expect(text).toContain('If the project has no such place, create none')
  expect(nudgeText('stop', gaugeOf(900, 1000), true)).toContain('already stored')
})

test('with auto-compaction off, every text measures against the window', () => {
  const gauge = gaugeOf(164_000, 200_000, false)

  expect(nudgeText('stop', gauge, false)).toContain(
    'The context window is 82% full (164k of 200k tokens), and auto-compaction is off. Stop at the next breakpoint',
  )
  expect(toastText('stop', gauge)).toBe(
    'Context window 82% full. Claude will stop at the next breakpoint.',
  )
  expect(readyText(gauge)).toBe('Ready to compact: the context window is 82% full.')
  expect(greetingText(200_000, false, { warn: 144_000, stop: 160_000 }).detail).toBe(
    ' · nudges at 144k and 160k tokens · auto-compact is off',
  )
})

test('instructions are trimmed, and refused when empty or too long', () => {
  expect(cleanInstructions('  keep the plan\n\n\n\ndrop the logs  ')).toBe(
    'keep the plan\n\ndrop the logs',
  )
  expect(cleanInstructions(42)).toBe('')
  expect(refusalOf('')).toContain('Give `instructions`')
  expect(refusalOf('x'.repeat(MAX_INSTRUCTIONS + 1))).toContain('Shorten')
  expect(refusalOf('keep the plan')).toBeUndefined()
  expect(compactLine('keep the plan')).toBe('/compact keep the plan')
})

test('the toast says what Claude is doing', () => {
  expect(toastText('warn', gaugeOf(820, 1000))).toBe(
    'Context at 82% of auto-compact. Claude is looking for a breakpoint.',
  )
  expect(toastText('stop', gaugeOf(900, 1000))).toBe(
    'Context at 90% of auto-compact. Claude will stop at the next breakpoint.',
  )
})

test('the status line says what the mod is doing', () => {
  const base = {
    told: 'none',
    hasProposal: false,
    age: 0,
    versionNote: undefined,
    lastError: undefined,
  } as const

  // Before the first nudge, with nothing wrong, there is no line at all.
  expect(statusText({ ...base, gauge: null })).toBeUndefined()
  expect(statusText({ ...base, gauge: gaugeOf(420, 1000) })).toBeUndefined()
  expect(statusText({ ...base, gauge: gaugeOf(820, 1000), told: 'warn' })).toBe(
    'context at 82% of auto-compact · looking for a breakpoint',
  )
  expect(statusText({ ...base, gauge: gaugeOf(900, 1000), told: 'stop' })).toBe(
    'context at 90% of auto-compact · stopping at the next breakpoint',
  )
  expect(statusText({ ...base, gauge: gaugeOf(900, 1000), told: 'stop', hasProposal: true })).toBe(
    'context at 90% of auto-compact · /compact ready',
  )
  expect(
    statusText({ ...base, gauge: gaugeOf(900, 1000), hasProposal: true, age: 18_400 }),
  ).toBe('context at 90% of auto-compact · /compact ready, saved 18k tokens ago')
  expect(
    statusText({ ...base, gauge: null, versionNote: 'untested on Claude Code 9.9.9' }),
  ).toBe('untested on Claude Code 9.9.9')
  expect(statusText({ ...base, gauge: null, lastError: 'tool.call: boom' })).toBe(
    'error in tool.call: boom',
  )
  expect(
    statusText({
      ...base,
      gauge: gaugeOf(420, 1000),
      versionNote: 'untested on Claude Code 9.9.9',
    }),
  ).toBe('context at 42% of auto-compact · untested on Claude Code 9.9.9')
})

test('the green line names the nudges and the auto-compaction point', () => {
  expect(greetingText(LARGE, true, thresholdsOf(LARGE, configOf({})))).toEqual({
    text: '✓ compact-warning is working',
    detail: ' · nudges at 774k and 851k tokens · auto-compact at 967k',
  })
  expect(greetingText(SMALL, true, thresholdsOf(SMALL, configOf({}))).detail).toBe(
    ' · nudges at 124k and 137k tokens · auto-compact at 167k',
  )
  expect(greetingText(LARGE, true, { warn: 300_000, stop: 300_000 }).detail).toBe(
    ' · one nudge at 300k tokens · auto-compact at 967k',
  )
})

test('the row above the prompt says what to run', () => {
  expect(readyText(null)).toBe('Ready to compact.')
  expect(readyText(gaugeOf(850, 1000))).toBe('Ready to compact at 85% of auto-compact.')
  expect(readyHint(0)).toBe(' Run /compact: the saved instructions apply.')
  expect(readyHint(18_400)).toBe(
    ' Run /compact: the saved instructions apply. They were saved 18k tokens ago.',
  )
})

const REPORT: Report = {
  gauge: gaugeOf(116_040, LARGE),
  limit: LARGE,
  isAutoCompact: true,
  told: 'none',
  proposal: null,
  config: configOf({}),
  engineVersion: '2.1.325',
  versionNote: undefined,
  lastError: undefined,
}

test('the report opens with the verdict of the checks', () => {
  expect(healthText(undefined, undefined)).toBe('Health: working')
  expect(healthText('untested on Claude Code 9.9.9', undefined)).toBe(
    "Health: needs attention, untested on Claude Code 9.9.9 (run tools/check in the mod's folder)",
  )
  expect(healthText(undefined, 'tool.call: boom')).toBe(
    'Health: needs attention, error in tool.call: boom',
  )
})

test('the report is one fact to a line', () => {
  expect(reportText(REPORT)).toBe(
    [
      'Health: working',
      'Context: 116k of 967k tokens, 12% of auto-compact',
      'Nudges: at 774k and 851k tokens, none sent yet',
      'Compact without asking: off',
      'Claude Code: 2.1.325',
      'Proposal: none',
    ].join('\n'),
  )

  const waiting = reportText({
    ...REPORT,
    gauge: gaugeOf(880_000, LARGE),
    told: 'stop',
    proposal: { instructions: 'Keep the plan.', tokens: 860_000, isHandedOver: true },
  })

  expect(waiting).toContain('Nudges: at 774k and 851k tokens, second sent')
  expect(waiting).toContain('Proposal: ready for /compact, saved 20k tokens ago\nKeep the plan.')

  expect(reportText({ ...REPORT, gauge: null })).toContain(
    'Context: no reading yet, auto-compact at 967k tokens',
  )
  expect(
    reportText({ ...REPORT, gauge: gaugeOf(164_000, 200_000, false), limit: 200_000, isAutoCompact: false }),
  ).toContain('Context: 164k of 200k tokens, 82% of the window (auto-compact is off)')
})

test('old instructions reach the summary with a caveat', () => {
  const proposal = { instructions: 'Keep the plan.', tokens: 800_000, isHandedOver: true }

  expect(ageOf(proposal, gaugeOf(804_000, LARGE))).toBe(4000)
  expect(ageOf({ ...proposal, tokens: null }, gaugeOf(804_000, LARGE))).toBe(0)
  expect(ageOf(proposal, null)).toBe(0)
  expect(instructionsFor(proposal, gaugeOf(804_000, LARGE))).toBe('Keep the plan.')
  expect(instructionsFor(proposal, gaugeOf(820_300, LARGE))).toBe(
    'Keep the plan.\n\n(These instructions were written about 20k tokens of conversation ago. Where the later conversation differs from them, the later conversation wins.)',
  )
})

// Only the fields the mod reads: the engine's own type grows between releases.
const agent = (id: string, status: AgentStatus, parentId?: string): AgentInfo =>
  ({
    id,
    description: `Task ${id}`,
    type: 'Explore',
    status,
    ...(parentId === undefined ? {} : { parentId }),
  }) as AgentInfo

test('an agent is unfinished while its loop is at work', () => {
  const statuses: AgentStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']

  expect(statuses.filter(isUnfinished)).toEqual(['pending', 'running', 'waiting'])
  // A status the types do not know yet counts: better one agent too many.
  expect(isUnfinished('paused' as AgentStatus)).toBe(true)
})

test('only the agents that report to the main conversation are kept', () => {
  const kept = unfinishedOf([
    agent('a1', 'running'),
    agent('a2', 'completed'),
    agent('a3', 'running', 'a1'),
    agent('a4', 'waiting'),
  ])

  expect(kept.map(each => each.id)).toEqual(['a1', 'a4'])
})

test('a tool result that starts a background task names it', () => {
  expect(
    taskOf(
      { tool: 'Bash', command: 'npm run build\nnpm test', description: 'Build the site' },
      { backgroundTaskId: 'b1' },
    ),
  ).toEqual({ id: 'b1', kind: 'command', label: 'Build the site' })
  expect(taskOf({ tool: 'Bash', command: 'npm run build\nnpm test' }, { backgroundTaskId: 'b1' })?.label).toBe(
    'npm run build',
  )
  expect(taskOf({ tool: 'Bash', command: 'x'.repeat(200) }, { backgroundTaskId: 'b1' })?.label.length).toBe(60)
  expect(
    taskOf({ tool: 'Workflow' }, { status: 'async_launched', taskId: 'w1', workflowName: 'review-changes' }),
  ).toEqual({ id: 'w1', kind: 'workflow', label: 'review-changes' })
  expect(taskOf({ tool: 'Monitor', description: 'Watch the deploy' }, { taskId: 'm1', timeoutMs: 0 })).toEqual({
    id: 'm1',
    kind: 'monitor',
    label: 'Watch the deploy',
  })

  // A foreground command, a command that is ended with the final response,
  // and another tool's task id start nothing that reports later.
  expect(taskOf({ tool: 'Bash', command: 'ls' }, { stdout: '' })).toBeUndefined()
  expect(
    taskOf({ tool: 'Bash', command: 'ls' }, { backgroundTaskId: 'b2', backgroundEndsWithFinalResponse: true }),
  ).toBeUndefined()
  expect(taskOf({ tool: 'TaskUpdate' }, { taskId: '7' })).toBeUndefined()
  expect(taskOf({ tool: 'Bash' }, undefined)).toBeUndefined()
})

test('a stopped task and an ended task are told apart from a running one', () => {
  expect(stoppedOf({ tool: 'TaskStop', task_id: 'b1' }, { message: 'Stopped', task_id: 'b1' })).toBe('b1')
  expect(stoppedOf({ tool: 'Bash' }, { task_id: 'b1' })).toBeUndefined()

  const notice = (id: string, status?: string): string =>
    `<task-notification>\n<task-id>${id}</task-id>\n${status === undefined ? '' : `<status>${status}</status>\n`}<summary>Background command</summary>\n</task-notification>`

  expect(endedIn(notice('b1', 'completed'))).toEqual(['b1'])
  expect(endedIn(`${notice('b1', 'failed')}\n${notice('m1')}\n${notice('w1', 'killed')}`)).toEqual(['b1', 'w1'])
  // An event of a monitor that goes on, and a word that ends nothing.
  expect(endedIn(notice('m1'))).toEqual([])
  expect(endedIn(notice('m1', 'running'))).toEqual([])
  expect(endedIn('go on')).toEqual([])
})

test('the stored answer names what is still running, and counts what is past ten', () => {
  const tasks: Task[] = [
    { id: 'b1', kind: 'command', label: 'Build the site' },
    { id: 'm1', kind: 'monitor', label: '' },
  ]

  expect(runningOf([agent('a1', 'running'), agent('a2', 'completed')], tasks)).toEqual([
    'agent "Task a1" (Explore, id a1)',
    'command "Build the site" (id b1)',
    'monitor (id m1)',
  ])
  expect(runningText([])).toBe('')
  expect(storedText(null, false, [])).toContain('Stored. End your turn now, with')
  expect(storedText(gaugeOf(850, 1000), false, [])).toContain(
    'Stored. The context is at 85% of the point where auto-compaction fires (850 of 1k tokens). End your turn now',
  )
  expect(storedText(null, true, ['monitor (id m1)'])).toContain(
    'Stored. Still running, as far as the mod can tell: monitor (id m1). Each one may report',
  )
  expect(storedText(null, true, ['monitor (id m1)'])).toContain('Then end your turn. The mod compacts')

  const many = Array.from({ length: MAX_NAMED + 2 }, (_, i) => `monitor (id m${i})`)
  const text = runningText(many)
  expect(text).toContain(`monitor (id m${MAX_NAMED - 1}); and 2 more.`)
  expect(text).not.toContain(`(id m${MAX_NAMED})`)
})
