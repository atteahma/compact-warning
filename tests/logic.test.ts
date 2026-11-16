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
  refusalOf,
  runningOf,
  runningText,
  statusText,
  stoppedOf,
  storedText,
  taskOf,
  unfinishedOf,
} from '../hooks/logic'
import type { Task } from '../hooks/logic'

test('the options default to 80 and 88, attended', () => {
  expect(configOf({})).toEqual({ warnPercent: 80, stopPercent: 88, isUnattended: false })
})

test('the second threshold never sits under the first', () => {
  const config = configOf({ warnPercent: 90, stopPercent: 70, unattended: true })

  expect(config).toEqual({ warnPercent: 90, stopPercent: 90, isUnattended: true })
})

test('a threshold outside 1 to 99 is pulled back in', () => {
  expect(configOf({ warnPercent: 0, stopPercent: 250 })).toEqual({
    warnPercent: 1,
    stopPercent: 99,
    isUnattended: false,
  })
})

test('the level follows the thresholds', () => {
  const config = configOf({})

  expect(levelOf(79, config)).toBe('none')
  expect(levelOf(80, config)).toBe('warn')
  expect(levelOf(87, config)).toBe('warn')
  expect(levelOf(88, config)).toBe('stop')
  expect(isStronger('stop', 'warn')).toBe(true)
  expect(isStronger('warn', 'warn')).toBe(false)
  expect(hasShrunk(74, config)).toBe(true)
  expect(hasShrunk(75, config)).toBe(false)
})

test('the gauge is a whole percentage of the auto-compaction point', () => {
  expect(gaugeOf(773_600, 967_000)).toEqual({ tokens: 773_600, limit: 967_000, percent: 80 })
  expect(gaugeOf(10, 0).percent).toBe(1000)
})

test('the nudge names the fill and the tool', () => {
  const text = nudgeText('warn', gaugeOf(773_600, 967_000), false)

  expect(text).toContain('80% of the point where auto-compaction fires')
  expect(text).toContain('773 600 of 967 000 tokens')
  expect(text).toContain('mcp__compact-warning__propose_compact')
  expect(nudgeText('stop', gaugeOf(900, 1000), true)).toContain('already stored')
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

test('the status line says what the mod is doing', () => {
  const base = {
    told: 'none',
    hasProposal: false,
    age: 0,
    versionNote: undefined,
    lastError: undefined,
  } as const

  // Under the first threshold, with nothing wrong, there is no line at all.
  expect(statusText({ ...base, gauge: null })).toBeUndefined()
  expect(statusText({ ...base, gauge: gaugeOf(420, 1000) })).toBeUndefined()
  expect(statusText({ ...base, gauge: gaugeOf(820, 1000), told: 'warn' })).toBe(
    'context 82% of auto-compact, looking for a breakpoint',
  )
  expect(statusText({ ...base, gauge: gaugeOf(900, 1000), told: 'stop', hasProposal: true })).toBe(
    'context 90% of auto-compact, /compact line ready',
  )
  expect(
    statusText({ ...base, gauge: null, versionNote: 'untested on Claude Code 9.9.9' }),
  ).toBe('mod untested on Claude Code 9.9.9')
  expect(statusText({ ...base, gauge: null, lastError: 'tool.call: boom' })).toBe(
    'mod error in tool.call: boom',
  )
  expect(
    statusText({
      ...base,
      gauge: gaugeOf(420, 1000),
      versionNote: 'untested on Claude Code 9.9.9',
    }),
  ).toBe('context 42% of auto-compact · mod untested on Claude Code 9.9.9')
  expect(
    statusText({ ...base, gauge: gaugeOf(900, 1000), hasProposal: true, age: 18_400 }),
  ).toBe('context 90% of auto-compact, /compact line ready, 18 000 tokens old')
})

test('the green line names the thresholds and the auto-compaction point', () => {
  expect(greetingText(null, 967_000, configOf({}))).toBe(
    '✓ compact-warning is working. It warns at 80% and 88% of the auto-compaction point (967 000 tokens).',
  )
  expect(
    greetingText(gaugeOf(116_040, 967_000), 967_000, configOf({ warnPercent: 70, stopPercent: 70 })),
  ).toBe(
    '✓ compact-warning is working. It warns at 70% of the auto-compaction point (967 000 tokens). The context is at 12% now.',
  )
})

test('the report opens with the verdict of the checks', () => {
  expect(healthText('2.1.325', undefined, undefined)).toContain('Health: working.')
  expect(healthText('9.9.9', 'untested on Claude Code 9.9.9', undefined)).toBe(
    'Health: needs attention. The mod has not passed its tests on Claude Code 9.9.9. Run tools/check in its folder.',
  )
  expect(healthText('2.1.325', undefined, 'tool.call: boom')).toBe(
    'Health: needs attention. A hook of the mod failed in tool.call: boom.',
  )
})

test('old instructions reach the summary with a caveat', () => {
  const proposal = { instructions: 'Keep the plan.', tokens: 800_000, isHandedOver: true }

  expect(ageOf(proposal, gaugeOf(804_000, 967_000))).toBe(4000)
  expect(ageOf({ ...proposal, tokens: null }, gaugeOf(804_000, 967_000))).toBe(0)
  expect(ageOf(proposal, null)).toBe(0)
  expect(instructionsFor(proposal, gaugeOf(804_000, 967_000))).toBe('Keep the plan.')
  expect(instructionsFor(proposal, gaugeOf(820_300, 967_000))).toBe(
    'Keep the plan.\n\n(These instructions were written about 20 000 tokens of conversation ago. Where the later conversation differs from them, the later conversation wins.)',
  )
})

const agent = (id: string, status: AgentStatus, parentId?: string): AgentInfo => ({
  id,
  description: `Task ${id}`,
  type: 'Explore',
  status,
  ...(parentId === undefined ? {} : { parentId }),
})

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
  expect(storedText(null, true, ['monitor (id m1)'])).toContain(
    'Stored. Still running, as far as the mod can tell: monitor (id m1). Each one may report',
  )
  expect(storedText(null, true, ['monitor (id m1)'])).toContain('Then end your turn. The mod compacts')

  const many = Array.from({ length: MAX_NAMED + 2 }, (_, i) => `monitor (id m${i})`)
  const text = runningText(many)
  expect(text).toContain(`monitor (id m${MAX_NAMED - 1}); and 2 more.`)
  expect(text).not.toContain(`(id m${MAX_NAMED})`)
})
