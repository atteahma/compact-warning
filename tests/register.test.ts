import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage, SessionUsage } from 'claude-code'

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
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'hello', toolUses: [] }]
const last = (list: readonly string[]): string => list[list.length - 1] ?? ''

/** Calls the mod's own tool, which the typed tool names may not list. */
const propose = ($: Engine, instructions: string) =>
  $.tool.call({ tool: TOOL, instructions } as never)

test('under the first threshold a tool call carries no note', async ($, on) => {
  const w = world(on, { tokens: at(42) })
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.context ?? []).toEqual([])
  expect(last(w.statuses)).toBe('context 42% of auto-compact')
  expect(w.toasts).toEqual([])
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
  expect(w.fills).toEqual([])

  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual(['/compact Keep the plan.'])
  expect(last(w.toasts)).toContain('Press Enter')
  expect(last(w.statuses)).toBe('context 85% of auto-compact, /compact line ready')

  // Offered once: a later turn end leaves the prompt box alone.
  await $.turn.complete(TURN_END)
  expect(w.fills.length).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
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

    expect(await ui.find({ type: 'Text', text: /Ready to compact \(85%/ })).toBeDefined()
    await ui.press({ key: 'fill' })
    await ui.unmount()
  }

  expect(w.fills.length).toBe(3)
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
