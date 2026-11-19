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
  /** The token count where auto-compaction fires; undefined while it is off. */
  limit: number | undefined
  draft: string
  tested: string | undefined
  isUsageBroken: boolean
  agents: AgentInfo[]
  isAgentListBroken: boolean
  /** What the next tool call answers. */
  toolResult: unknown
  statuses: string[]
  toasts: string[]
  fills: string[]
  prompts: Array<{ text: string; context: readonly string[] }>
  compactions: Compaction[]
}

function world(on: On, start: Partial<World> = {}): World {
  const w: World = {
    tokens: undefined,
    limit: LIMIT,
    draft: '',
    tested: VERSION,
    isUsageBroken: false,
    agents: [],
    isAgentListBroken: false,
    toolResult: {},
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
        ...(e.breakdown === undefined
          ? {}
          : {
              breakdown:
                w.limit === undefined
                  ? { rawMaxTokens: WINDOW, isAutoCompactEnabled: false }
                  : { autoCompactThreshold: w.limit, isAutoCompactEnabled: true },
            }),
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
  on('tool.call', () => ({ result: w.toolResult as never }))
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

/** An agent as the mod reads one: the engine's own type grows between releases. */
const agent = (given: Pick<AgentInfo, 'id' | 'description' | 'status'> & { parentId?: string }) =>
  ({ type: 'Explore', ...given }) as AgentInfo

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
  const line = await ui.find({ type: 'Text', text: /^✓ compact-warning is working$/ })
  await ui.unmount()

  return line
}

/** The dim detail beside the green line. */
async function greenDetail($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await band($, surface)
  const detail = await ui.find({ type: 'Text', text: /^ · / })
  await ui.unmount()

  return detail
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
    const detail = await greenDetail($, surface)

    expect(line?.props['color']).toBe('success')
    expect(detail?.text).toBe(' · nudges at 774k and 851k tokens · auto-compact at 967k')
    expect(detail?.props['dimColor']).toBe(true)
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

  expect(await greenLine($)).toBeDefined()

  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(await greenLine($)).toBeUndefined()
})

test('a start check that fails shows no green line', async ($, on) => {
  mock.clock(on)
  const untested = world(on, { tokens: at(12), tested: '2.1.300' })
  await $.session.start(START)

  expect(await greenLine($)).toBeUndefined()
  expect(last(untested.statuses)).toContain('untested on Claude Code')
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
  expect(before.text).toContain(`Health: needs attention, untested on Claude Code ${VERSION}`)

  // tools/check passed in the meantime: the command reads the file again.
  w.tested = VERSION
  const after = await $.command.run(STATUS_COMMAND)
  expect(after.text).toContain('Health: working\n')
  expect(last(w.statuses)).toBe('')
})

test('each threshold is told once, with the tool result', async ($, on) => {
  const w = world(on, { tokens: at(80) })
  await $.session.start(START)

  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.context?.length).toBe(1)
  expect(first.context?.[0]).toContain('look for a good breakpoint')
  expect(last(w.statuses)).toBe('context at 80% of auto-compact · looking for a breakpoint')

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
  expect(String(stored.result)).not.toContain('Still running')
  expect(w.fills).toEqual([])

  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual(['/compact Keep the plan.'])
  expect(last(w.toasts)).toContain('Press Enter')
  expect(last(w.statuses)).toBe('context at 85% of auto-compact · /compact ready')

  // Offered once: a later turn end leaves the prompt box alone.
  await $.turn.complete(TURN_END)
  expect(w.fills.length).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)

    expect(await ui.find({ type: 'Text', text: /Ready to compact at 85% of auto-compact\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ Run \/compact: the saved instructions apply\.$/ })).toBeDefined()
    // The proposal has the row: the green line of the start check gives way.
    expect(await ui.find({ type: 'Text', text: /is working/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'Hide' })).toBeDefined()
    await ui.press({ key: 'fill' })
    await ui.unmount()
  }

  expect(w.fills.length).toBe(3)
})

test('a proposal names the agents that are still running', async ($, on) => {
  const w = world(on, {
    tokens: at(85),
    agents: [
      agent({ id: 'a1', description: 'Search the logs', status: 'running' }),
      agent({ id: 'a2', description: 'Read the docs', status: 'completed' }),
      // Spawned by a1: it reports to a1, not to the main conversation.
      agent({ id: 'a3', description: 'Count the lines', status: 'running', parentId: 'a1' }),
    ],
  })
  await $.session.start(START)
  const stored = await propose($, 'Keep the plan.')

  expect(String(stored.result)).toContain(
    'Still running, as far as the mod can tell: agent "Search the logs" (Explore, id a1). Each one may report',
  )
  expect(String(stored.result)).toContain('Then end your turn, with one or two lines')
  expect(String(stored.result)).not.toContain('a2')
  expect(String(stored.result)).not.toContain('a3')

  // The proposal is stored all the same.
  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual(['/compact Keep the plan.'])
})

test('a background task is named until the mod sees its end', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)

  w.toolResult = { backgroundTaskId: 'b1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the site' })
  w.toolResult = { status: 'async_launched', taskId: 'w1', workflowName: 'review-changes' }
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' } as never)
  // A subagent's command reports to the subagent, not to the main conversation.
  w.toolResult = { backgroundTaskId: 'b2' }
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
  w.toolResult = {}

  const first = await propose($, 'Keep the plan.')
  expect(String(first.result)).toContain(
    'Still running, as far as the mod can tell: command "Build the site" (id b1); workflow "review-changes" (id w1). Each',
  )
  expect(String(first.result)).not.toContain('b2')

  // The command's notification says it ended.
  await $.prompt.submit({
    text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })
  const second = await propose($, 'Keep the plan.')
  expect(String(second.result)).toContain('can tell: workflow "review-changes" (id w1). Each')

  // The model stops the workflow.
  w.toolResult = { message: 'Stopped', task_id: 'w1', task_type: 'local_workflow' }
  await $.tool.call({ tool: 'TaskStop', task_id: 'w1' } as never)
  const third = await propose($, 'Keep the plan.')
  expect(String(third.result)).not.toContain('Still running')
  expect(String(third.result)).toContain('End your turn now')
})

test('an agent list that fails holds no proposal back', async ($, on) => {
  const w = world(on, { tokens: at(85), isAgentListBroken: true })
  await $.session.start(START)
  const stored = await propose($, 'Keep the plan.')

  expect(String(stored.result)).toContain('Stored.')
  expect(last(w.statuses)).toContain('error in the agent list:')
  expect(w.toasts.join('\n')).toContain('Error in the agent list')

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
    'context at 87% of auto-compact · /compact ready, saved 20k tokens ago',
  )

  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions[0]?.instructions).toContain('Keep the plan.\n\n(These instructions were written about 20k tokens')
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
    'The conversation was compacted with your own instructions. If you wrote the state down, read it first. Then continue the work.',
  ])
})

test('the percentages are options', { options: { warnPercent: 10, stopPercent: 20 } }, async ($, on) => {
  world(on, { tokens: at(21) })
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.context?.[0]).toContain('Stop at the next breakpoint')
})

test('a token count gives the nudge before the percentage', { options: { warnTokens: 250_000, stopTokens: 300_000 } }, async ($, on) => {
  const w = world(on, { tokens: 249_000 })
  await $.session.start(START)

  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])

  w.tokens = 250_000
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0]).toContain(
    'look for a good breakpoint',
  )

  w.tokens = 300_000
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0]).toContain(
    'Stop at the next breakpoint',
  )
})

test('on a small window the nudges come earlier, and the green line says where', async ($, on) => {
  mock.clock(on)
  // A 200k window: auto-compaction fires at 167 000 tokens.
  const w = world(on, { tokens: 113_000, limit: 167_000 })
  await $.session.start(START)

  expect((await greenDetail($))?.text).toBe(
    ' · nudges at 124k and 137k tokens · auto-compact at 167k',
  )
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])

  // 82% of the point: 30 000 tokens remain for the hand-over.
  w.tokens = 137_000
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0]).toContain(
    'Stop at the next breakpoint',
  )
})

test('with auto-compaction off the mod measures against the window', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: 100_000, limit: undefined })
  await $.session.start(START)

  // The window is 1M tokens: the nudges come at 80% and 88% of it.
  expect((await greenDetail($))?.text).toBe(
    ' · nudges at 800k and 880k tokens · auto-compact is off',
  )

  w.tokens = 800_000
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.context?.[0]).toContain('The context window is 80% full (800k of 1M tokens)')
  expect(last(w.statuses)).toBe('context window 80% full · looking for a breakpoint')
})

test('an installed copy, with no record of a tested version, skips the version check', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: at(12), tested: undefined })
  await $.session.start(START)

  expect(await greenLine($)).toBeDefined()
  expect(w.toasts).toEqual([])
  expect(w.statuses.every(text => text === '')).toBe(true)

  const report = await $.command.run(STATUS_COMMAND)
  expect(report.text).toContain('Health: working\n')
  expect(report.text).toContain(`Claude Code: ${VERSION}`)
})

test('a Claude Code version the tests have not passed on shows in the status line', async ($, on) => {
  const w = world(on, { tokens: at(10), tested: '2.1.300' })
  await $.session.start(START)

  expect(last(w.statuses)).toBe(
    `context at 10% of auto-compact · untested on Claude Code ${VERSION}`,
  )
  expect(w.toasts[0]).toBe(
    `Untested on Claude Code ${VERSION}. Run tools/check in the mod's folder.`,
  )
})

test('a failure inside the mod shows, and the tool call still answers', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  w.isUsageBroken = true
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBeUndefined()
  expect(last(w.statuses)).toContain('error in tool.call:')
  expect(last(w.toasts)).toContain('Error in tool.call:')
})

test('a /clear forgets the proposal', async ($, on) => {
  const w = world(on, { tokens: at(90) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: undefined }])
})
