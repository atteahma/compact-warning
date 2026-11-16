import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, SessionMessage, SessionUsage } from 'claude-code'

const TOOL = 'mcp__compact-warning__propose_compact'
const WINDOW = 1_000_000
const LIMIT = 967_000
const VERSION = '2.1.325'

/** `percent` of the auto-compaction point, in tokens. */
const at = (percent: number): number => Math.ceil((LIMIT * percent) / 100)

type Compaction = { trigger: string; instructions: string | undefined }

/** The session beneath the mod: what it reads, and a record of what it did. */
type World = {
  tokens: number | undefined
  draft: string
  tested: string | undefined
  isUsageBroken: boolean
  agents: AgentInfo[]
  isAgentListBroken: boolean
  statuses: string[]
  toasts: string[]
  fills: string[]
  prompts: Array<{ text: string; context: readonly string[] }>
  compactions: Compaction[]
}

function world(on: On, start: Partial<World> = {}): World {
  const w: World = {
    tokens: undefined,
    draft: '',
    tested: VERSION,
    isUsageBroken: false,
    agents: [],
    isAgentListBroken: false,
    statuses: [],
    toasts: [],
    fills: [],
    prompts: [],
    compactions: [],
    ...start,
  }

  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: VERSION } }))
  on('session.usage', (_, e) => {
    if (w.isUsageBroken) {
      throw new Error('usage is gone')
    }

    const usage = {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: WINDOW,
        ...(w.tokens === undefined ? {} : { tokens: w.tokens }),
        ...(e.breakdown === undefined ? {} : { breakdown: { autoCompactThreshold: LIMIT } }),
      },
    }

    return { value: usage as unknown as SessionUsage }
  })
  on('agent.list', () => {
    if (w.isAgentListBroken) {
      throw new Error('the list is gone')
    }

    return { value: w.agents }
  })
  on('fs.read', () => {
    if (w.tested === undefined) {
      throw new Error('no such file')
    }

    return { value: `${w.tested}\n` }
  })
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'compact-warning' } }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.statuses.push(e.text ?? '')

    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', (_, e) => {
    w.fills.push(e.text)
    w.draft = e.text

    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    w.prompts.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text }
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.compact', (_, e) => {
    // A plugin's own call arrives bare in a test: in a session the engine
    // stamps its trigger and its messages.
    w.compactions.push({ trigger: e.trigger ?? 'plugin', instructions: e.instructions })

    return { messages: e.messages ?? MESSAGES }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  return w
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const TURN_END = {
  answer: 'done',
  durationMs: 1,
  reason: 'answer',
  isAborted: false,
  turnId: 't1',
} as const
const STATUS_COMMAND = {
  command: 'compact-warning',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'hello', toolUses: [] }]
const last = (list: readonly string[]): string => list[list.length - 1] ?? ''

/** Calls the mod's own tool, which the typed tool names may not list. */
const propose = ($: Engine, instructions: string) =>
  $.tool.call({ tool: TOOL, instructions } as never)

/** Draws the mod's row above the prompt, as a surface does. */
const band = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({
    plugin: 'compact-warning',
    component: 'AbovePrompt',
    surface,
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })

/** The green line of a passed start check, when the row above the prompt has it. */
async function greenLine($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await band($, surface)
  const line = await ui.find({ type: 'Text', text: /compact-warning is working/ })
  await ui.unmount()

  return line
}

test('under the first threshold a tool call carries no note, and no status line shows', async ($, on) => {
  const w = world(on, { tokens: at(42) })
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.context ?? []).toEqual([])
  expect(w.statuses.every(text => text === '')).toBe(true)
  expect(w.toasts).toEqual([])
})

test('a passed start check shows a green line for a few seconds', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { tokens: at(12) })
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const line = await greenLine($, surface)

    expect(line?.text).toBe(
      '✓ compact-warning is working. It warns at 80% and 88% of the auto-compaction point (967 000 tokens). The context is at 12% now.',
    )
    expect(line?.props['color']).toBe('success')
  }

  await clock.advance(9000)
  expect(await greenLine($)).toBeDefined()

  await clock.advance(1000)
  expect(await greenLine($)).toBeUndefined()
})

test('the green line shows before the first response, and leaves at the first prompt', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.session.start(START)

  expect((await greenLine($))?.text).toBe(
    '✓ compact-warning is working. It warns at 80% and 88% of the auto-compaction point (967 000 tokens).',
  )

  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(await greenLine($)).toBeUndefined()
})

test('a start check that fails shows no green line', async ($, on) => {
  mock.clock(on)
  const untested = world(on, { tokens: at(12), tested: '2.1.300' })
  await $.session.start(START)

  expect(await greenLine($)).toBeUndefined()
  expect(last(untested.statuses)).toContain('mod untested on Claude Code')
})

test('a broken context reading fails the start check', async ($, on) => {
  mock.clock(on)
  const w = world(on, { isUsageBroken: true })
  await $.session.start(START)

  expect(await greenLine($)).toBeUndefined()
  expect(last(w.statuses)).toContain('error in session.start:')
})

test('a session with nobody at the prompt gets no green line', async ($, on) => {
  mock.clock(on)
  world(on, { tokens: at(12) })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  expect(await greenLine($)).toBeUndefined()
})

test('/compact-warning runs the checks again and prints the verdict', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: at(12), tested: '2.1.300' })
  await $.session.start(START)

  const before = await $.command.run(STATUS_COMMAND)
  expect(before.text).toContain('Health: needs attention. The mod has not passed its tests')

  // tools/check passed in the meantime: the command reads the file again.
  w.tested = VERSION
  const after = await $.command.run(STATUS_COMMAND)
  expect(after.text).toContain('Health: working.')
  expect(last(w.statuses)).toBe('')
})

test('each threshold is told once, with the tool result', async ($, on) => {
  const w = world(on, { tokens: at(80) })
  await $.session.start(START)

  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.context?.length).toBe(1)
  expect(first.context?.[0]).toContain('look for a good breakpoint')
  expect(last(w.statuses)).toBe('context 80% of auto-compact, looking for a breakpoint')

  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(second.context ?? []).toEqual([])

  w.tokens = at(88)
  const third = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(third.context?.[0]).toContain('Stop at the next breakpoint')
  expect(w.toasts.length).toBe(2)

  const fourth = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(fourth.context ?? []).toEqual([])
})

test('a subagent is never nudged', async ($, on) => {
  world(on, { tokens: at(95) })
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })

  expect(ran.context ?? []).toEqual([])
})

test('a prompt carries the nudge too, and a slash command none', async ($, on) => {
  const w = world(on, { tokens: at(81) })
  await $.session.start(START)
  await $.prompt.submit({
    text: '/help',
    command: { name: 'help', args: '' },
    wait: false,
    origin: { kind: 'composer' },
  })
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })

  expect(w.prompts[0]?.context).toEqual([])
  expect(w.prompts[1]?.context[0]).toContain('look for a good breakpoint')
})

test('a proposal becomes a /compact line when the turn ends', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  const stored = await propose($, '  Keep the plan.  ')

  expect(String(stored.result)).toContain('Stored.')
  expect(String(stored.result)).toContain('End your turn now')
  expect(String(stored.result)).not.toContain('have not finished')
  expect(w.fills).toEqual([])

  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual(['/compact Keep the plan.'])
  expect(last(w.toasts)).toContain('Press Enter')
  expect(last(w.statuses)).toBe('context 85% of auto-compact, /compact line ready')

  // Offered once: a later turn end leaves the prompt box alone.
  await $.turn.complete(TURN_END)
  expect(w.fills.length).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)

    expect(await ui.find({ type: 'Text', text: /Ready to compact \(85%/ })).toBeDefined()
    // The proposal has the row: the green line of the start check gives way.
    expect(await ui.find({ type: 'Text', text: /is working/ })).toBeUndefined()
    await ui.press({ key: 'fill' })
    await ui.unmount()
  }

  expect(w.fills.length).toBe(3)
})

test('a proposal names the agents that have not finished', async ($, on) => {
  const w = world(on, {
    tokens: at(85),
    agents: [
      { id: 'a1', description: 'Search the logs', type: 'Explore', status: 'running' },
      { id: 'a2', description: 'Read the docs', type: 'Explore', status: 'completed' },
      // Spawned by a1: it reports to a1, not to the main conversation.
      { id: 'a3', description: 'Count the lines', type: 'Explore', status: 'running', parentId: 'a1' },
    ],
  })
  await $.session.start(START)
  const stored = await propose($, 'Keep the plan.')

  expect(String(stored.result)).toContain(
    'Agents that have not finished: "Search the logs" (Explore, id a1). Each one may report',
  )
  expect(String(stored.result)).toContain('Then end your turn, with one or two lines')
  expect(String(stored.result)).not.toContain('a2')
  expect(String(stored.result)).not.toContain('a3')

  // The proposal is stored all the same.
  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual(['/compact Keep the plan.'])
})

test('an agent list that fails holds no proposal back', async ($, on) => {
  const w = world(on, { tokens: at(85), isAgentListBroken: true })
  await $.session.start(START)
  const stored = await propose($, 'Keep the plan.')

  expect(String(stored.result)).toContain('Stored.')
  expect(last(w.statuses)).toContain('mod error in the agent list:')
  expect(w.toasts.join('\n')).toContain('The mod failed in the agent list')

  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual(['/compact Keep the plan.'])
})

test('a draft the person is typing is kept', async ($, on) => {
  const w = world(on, { tokens: at(85), draft: 'half a thought' })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.turn.complete(TURN_END)

  expect(w.fills).toEqual([])
  expect(w.draft).toBe('half a thought')
  expect(last(w.toasts)).toContain('Type /compact')
})

test('instructions that are empty are refused', async ($, on) => {
  world(on, { tokens: at(85) })
  await $.session.start(START)
  const ran = await propose($, '   ')

  expect(ran.deny).toContain('Give `instructions`')
})

test('an automatic compaction uses the stored instructions', async ($, on) => {
  const w = world(on, { tokens: at(90) })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await propose($, 'Keep the plan.')
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: 'Keep the plan.' }])

  // The compaction cleared the proposal and the nudges.
  w.tokens = undefined
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions[1]).toEqual({ trigger: 'auto', instructions: undefined })

  w.tokens = at(80)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.context?.[0]).toContain('look for a good breakpoint')
})

test('instructions the person typed win, and a subagent is left alone', async ($, on) => {
  const w = world(on, { tokens: at(90) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'my own' })

  expect(w.compactions).toEqual([
    { trigger: 'auto', instructions: undefined },
    { trigger: 'manual', instructions: 'my own' },
  ])
})

test('Enter on the filled line counts as the stored instructions', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.turn.complete(TURN_END)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'Keep the plan.' })

  expect(w.compactions).toEqual([{ trigger: 'manual', instructions: 'Keep the plan.' }])
})

test('a proposal the conversation has moved on from is used with a caveat', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.turn.complete(TURN_END)

  w.tokens = at(85) + 20_000
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(last(w.statuses)).toBe(
    'context 87% of auto-compact, /compact line ready, 20 000 tokens old',
  )

  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions[0]?.instructions).toContain('Keep the plan.\n\n(These instructions were written about 20 000 tokens')
})

test('no summary is computed ahead of time for the main conversation', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')

  const ahead = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  expect(ahead.skip).toContain('the summary is written when the compaction runs')
  expect(w.compactions).toEqual([])

  // A subagent's own transcript is left alone.
  await $.session.compact({ trigger: 'precompute', messages: MESSAGES, agentId: 'a1' })
  expect(w.compactions).toEqual([{ trigger: 'precompute', instructions: undefined }])

  // The proposal is still there for the compaction that comes.
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions[1]).toEqual({ trigger: 'auto', instructions: 'Keep the plan.' })
})

test('with no proposal a compaction runs unchanged', async ($, on) => {
  const w = world(on, { tokens: at(97) })
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: undefined }])
})

test('unattended, the mod compacts and tells the session to go on', { options: { unattended: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  const stored = await propose($, 'Keep the plan.')

  expect(String(stored.result)).toContain('compacts the conversation')

  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual([])
  expect(w.compactions).toEqual([])

  await clock.advance(1000)
  expect(w.compactions).toEqual([{ trigger: 'plugin', instructions: 'Keep the plan.' }])
  expect(w.prompts.map(prompt => prompt.text)).toEqual([
    'The conversation was compacted with your own instructions. Read the state you wrote down, then continue the work.',
  ])
})

test('the thresholds are options', { options: { warnPercent: 10, stopPercent: 20 } }, async ($, on) => {
  world(on, { tokens: at(21) })
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.context?.[0]).toContain('Stop at the next breakpoint')
})

test('a Claude Code version the tests have not passed on shows in the status line', async ($, on) => {
  const w = world(on, { tokens: at(10), tested: '2.1.300' })
  await $.session.start(START)

  expect(last(w.statuses)).toBe(
    `context 10% of auto-compact · mod untested on Claude Code ${VERSION}`,
  )
  expect(w.toasts[0]).toContain('has not passed its tests')
})

test('a failure inside the mod shows, and the tool call still answers', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  w.isUsageBroken = true
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBeUndefined()
  expect(last(w.statuses)).toContain('error in tool.call:')
  expect(last(w.toasts)).toContain('The mod failed in tool.call')
})

test('a /clear forgets the proposal', async ($, on) => {
  const w = world(on, { tokens: at(90) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: undefined }])
})
