import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, SessionMessage, SessionUsage } from 'claude-code'

const TOOL = 'mcp__compact-warning__propose_compact'
const WINDOW = 1_000_000
const LIMIT = 967_000
const VERSION = '2.1.326'

/** `percent` of the auto-compaction point, in tokens. */
const at = (percent: number): number => Math.ceil((LIMIT * percent) / 100)

type Compaction = { trigger: string; instructions: string | undefined }

/** The session beneath the mod: what it reads, and a record of what it did. */
type World = {
  tokens: number | undefined
  /** The token count where auto-compaction fires; undefined while it is off. */
  limit: number | undefined
  draft: string
  /** The Claude Code the session runs on. */
  version: string
  /** What the mod's store holds under its settings key at the start. */
  settings: unknown
  isUsageBroken: boolean
  agents: AgentInfo[]
  isAgentListBroken: boolean
  /** True when a message to an agent cannot be delivered. */
  isSendRefused: boolean
  /** The messages the mod sent to agents. */
  sends: Array<{ to: string; text: string }>
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
    version: VERSION,
    settings: undefined,
    isUsageBroken: false,
    agents: [],
    isAgentListBroken: false,
    isSendRefused: false,
    sends: [],
    toolResult: {},
    statuses: [],
    toasts: [],
    fills: [],
    prompts: [],
    compactions: [],
    ...start,
  }

  mock.store(on, w.settings === undefined ? {} : { settings: w.settings })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: w.version } }))
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
  on('session.send', (_, e) => {
    if (w.isSendRefused) {
      return { isDelivered: false, reason: 'the recipient is gone' }
    }

    w.sends.push({ to: String(e.to), text: e.text })

    return { isDelivered: true }
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
const percent = (value: number) => ({ unit: 'percent', value }) as const
const tokens = (value: number) => ({ unit: 'tokens', value }) as const

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

/** A subagent at work, as the mod reads one: its context's size and its model's window. */
const worker = (id: string, tokenCount: number, contextWindowSize = WINDOW) =>
  ({ type: 'general-purpose', id, description: 'dig', status: 'running', tokenCount, contextWindowSize }) as AgentInfo

/** A tool call of the subagent `id`, as the mod hears it. */
const workerCall = ($: Engine, id: string) => $.tool.call({ tool: 'Bash', command: 'ls', agentId: id })

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

/** The line that says the mod is off, when the row above the prompt has it. */
async function offLine($: Engine) {
  const ui = await band($)
  const line = await ui.find({ type: 'Text', text: /^compact-warning is off$/ })
  const detail = await ui.find({ type: 'Text', text: /^ · needs Claude Code/ })
  await ui.unmount()

  return { line, detail }
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

test('on a Claude Code older than the floor the mod is off, and says so', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: at(95), version: '2.1.311' })
  await $.session.start(START)

  expect(await greenLine($)).toBeUndefined()
  const { line, detail } = await offLine($)
  expect(line?.props['color']).toBe('warning')
  expect(detail?.text).toBe(' · needs Claude Code 2.1.325 or later, this is 2.1.311')

  // No nudge, no status line, no toast: every hook passes its event on.
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.context ?? []).toEqual([])
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  expect(w.prompts[0]?.context).toEqual([])
  expect(w.statuses.every(text => text === '')).toBe(true)
  expect(w.toasts).toEqual([])

  const report = await $.command.run(STATUS_COMMAND)
  expect(report.text).toContain('Health: off, needs Claude Code 2.1.325 or later, this is 2.1.311')
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

test('/compact-warning prints the report, and after a failure what to do', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: at(12) })
  await $.session.start(START)

  const before = await $.command.run(STATUS_COMMAND)
  expect(before.text).toContain('Health: working\nContext: 116k of 967k tokens, 12% of auto-compact')
  expect(before.text).toContain('Settings: warn 80%, stop 88%, reserve 30k, unattended off, subagents on\n')
  expect(before.text).toContain(`Claude Code: ${VERSION}`)

  w.isUsageBroken = true
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  w.isUsageBroken = false
  const after = await $.command.run(STATUS_COMMAND)
  expect(after.text).toContain('Health: needs attention, error in tool.call:')
  expect(after.text).toContain('For a fix, run: claude plugin update compact-warning@compact-warning')
})

test('/compact-warning changes a setting for every session, and puts the defaults back', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: 249_000 })
  await $.session.start(START)

  const set = await $.command.run({ ...STATUS_COMMAND, args: 'stop 300k' })
  expect(set.text).toContain('Set stop to 300k.\n\nHealth: working')
  expect(set.text).toContain('Nudges: at 300k tokens, none sent yet')
  expect(set.text).toContain('Settings: warn 80%, stop 300k, reserve 30k, unattended off, subagents on\n')
  const both = await $.command.run({ ...STATUS_COMMAND, args: 'warn 250k' })
  expect(both.text).toContain('Settings: warn 250k, stop 300k, reserve 30k, unattended off, subagents on\n')
  expect(both.text).toContain('Nudges: at 250k and 300k tokens, none sent yet')

  // The change holds at once, without a reload.
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []).toEqual([])
  w.tokens = 250_000
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0]).toContain(
    'look for a good breakpoint',
  )

  const refused = await $.command.run({ ...STATUS_COMMAND, args: 'stop 80' })
  expect(refused.text).toContain('Give stop a percentage such as 80%, or a token count such as 250k.')
  expect(refused.text).toContain('/compact-warning reset')

  const reset = await $.command.run({ ...STATUS_COMMAND, args: 'reset' })
  expect(reset.text).toContain('Put the settings back to their defaults.')
  expect(reset.text).toContain('Nudges: at 774k and 851k tokens')
  expect(reset.text).toContain('Settings: warn 80%, stop 88%, reserve 30k, unattended off, subagents on\n')
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

test('a subagent gets a message that asks for its instructions, 50 000 tokens before its compaction', async ($, on) => {
  // The main conversation is far over its own nudges: they are not a subagent's.
  const w = world(on, { tokens: at(95), agents: [worker('a1', 916_999)] })
  await $.session.start(START)
  await workerCall($, 'a1')
  expect(w.sends).toEqual([])

  w.agents = [worker('a1', 917_000), worker('a2', 100_000)]
  // The request is a message, and the tool's result stays as it was.
  expect((await workerCall($, 'a1')).context ?? []).toEqual([])
  expect(w.sends.length).toBe(1)
  expect(w.sends[0]?.to).toContain('a1')
  expect(w.sends[0]?.text).toContain("This subagent's context is at 94% of the point")
  expect(w.sends[0]?.text).toContain('keep working')
  await workerCall($, 'a2')
  expect(w.sends.length).toBe(1)

  // It reads on: after its next tool call it gets one reminder, and no more follow.
  await workerCall($, 'a1')
  expect(w.sends[1]?.text).toContain('[compact-warning] A reminder from')
  await workerCall($, 'a1')
  expect(w.sends.length).toBe(2)
  // Nothing of this reaches the person, and the main conversation is not told.
  expect(w.toasts).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0]).toContain(
    'Stop at the next breakpoint',
  )
})

test('a subagent on a small window is asked earlier, and one that is not listed never', async ($, on) => {
  const w = world(on, { tokens: at(10), agents: [worker('a1', 125_249, 200_000)] })
  await $.session.start(START)
  await workerCall($, 'a1')
  await workerCall($, 'gone')
  expect(w.sends).toEqual([])

  w.agents = [worker('a1', 125_250, 200_000)]
  await workerCall($, 'a1')
  expect(w.sends[0]?.text).toContain('(125k of 167k tokens)')
})

test('a request that cannot be sent as a message travels with the tool result', async ($, on) => {
  const w = world(on, { tokens: at(10), agents: [worker('a1', 920_000)], isSendRefused: true })
  await $.session.start(START)
  const ran = await workerCall($, 'a1')

  expect(w.sends).toEqual([])
  expect(ran.context?.length).toBe(1)
  expect(ran.context?.[0]).toContain('[compact-warning] From compact-warning, a Claude Code mod')
})

test("a subagent's compaction uses the instructions it proposed", async ($, on) => {
  const w = world(on, { tokens: at(10), agents: [worker('a1', 920_000)] })
  await $.session.start(START)
  await workerCall($, 'a1')
  const stored = await $.tool.call({ tool: TOOL, instructions: 'Keep the task.', agentId: 'a1' } as never)
  expect(stored.result).toBe(
    'Stored. Keep working: when Claude Code compacts this conversation, the summary follows these instructions.',
  )
  // It has answered, and is not asked again.
  await workerCall($, 'a1')
  expect(w.sends.length).toBe(1)
  // It is not the main conversation's proposal: no /compact line is offered.
  await $.turn.complete(TURN_END)
  expect(w.fills).toEqual([])

  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a2' })
  w.agents = [worker('a1', 966_000)]
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  expect(w.compactions.map(each => each.instructions)).toEqual([
    undefined,
    undefined,
    'Keep the task.\n\n(These instructions were written about 46k tokens of conversation ago. Where the later conversation differs from them, the later conversation wins.)',
  ])

  // The compaction cleared them, and the subagent is asked again when it refills.
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  expect(w.compactions[3]?.instructions).toBe(undefined)
  w.agents = [worker('a1', 930_000)]
  await workerCall($, 'a1')
  expect(w.sends[1]?.text).toContain('[compact-warning] From compact-warning')
})

test('a subagent that proposes without being asked is taken at its word, and forgotten when its run ends', async ($, on) => {
  const w = world(on, { tokens: at(10), agents: [worker('a1', 300_000)] })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, instructions: 'Keep the task.', agentId: 'a1' } as never)
  const refused = await $.tool.call({ tool: TOOL, instructions: '  ', agentId: 'a1' } as never)
  expect(refused.deny).toContain('Give `instructions`')

  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1', instructions: 'theirs' })
  expect(w.compactions[0]?.instructions).toBe('theirs')

  await $.tool.call({ tool: TOOL, instructions: 'Keep the task.', agentId: 'a1' } as never)
  await $.turn.complete({ ...TURN_END, agentId: 'a1' })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  expect(w.compactions[1]?.instructions).toBe(undefined)
})

test('with the setting off, and with auto-compaction off, a subagent is left alone', async ($, on) => {
  mock.clock(on)
  const w = world(on, {
    tokens: at(10),
    agents: [worker('a1', 950_000)],
    settings: { isForSubagents: false },
  })
  await $.session.start(START)
  expect((await workerCall($, 'a1')).context ?? []).toEqual([])
  expect(w.sends).toEqual([])
  const refused = await $.tool.call({ tool: TOOL, instructions: 'Keep the task.', agentId: 'a1' } as never)
  expect(refused.deny).toBe('Only the main conversation can propose a compaction. A subagent cannot.')
  await $.session.compact({ trigger: 'precompute', messages: MESSAGES, agentId: 'a1' })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  expect(w.compactions).toEqual([
    { trigger: 'precompute', instructions: undefined },
    { trigger: 'auto', instructions: undefined },
  ])

  // On again, but no compaction will come that instructions could steer.
  await $.command.run({ ...STATUS_COMMAND, args: 'subagents on' })
  w.limit = undefined
  await $.command.run(STATUS_COMMAND)
  expect((await workerCall($, 'a1')).context ?? []).toEqual([])
  expect(w.sends).toEqual([])
})

test("a subagent's instructions reach its compaction when its context cannot be read", async ($, on) => {
  const w = world(on, { tokens: at(10), agents: [worker('a1', 920_000)] })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, instructions: 'Keep the task.', agentId: 'a1' } as never)
  w.isAgentListBroken = true
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: 'Keep the task.' }])
})

test('on Claude Code 2.1.325 the mod works, and leaves subagents alone', async ($, on) => {
  mock.clock(on)
  const w = world(on, { tokens: at(80), agents: [worker('a1', 950_000)], version: '2.1.325' })
  await $.session.start(START)

  // The main conversation is nudged as on any newer Claude Code.
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context?.[0]).toContain(
    'look for a good breakpoint',
  )

  // A subagent is not asked, cannot propose, and its compaction is left as it comes.
  expect((await workerCall($, 'a1')).context ?? []).toEqual([])
  expect(w.sends).toEqual([])
  const refused = await $.tool.call({ tool: TOOL, instructions: 'Keep the task.', agentId: 'a1' } as never)
  expect(refused.deny).toBe('Only the main conversation can propose a compaction. A subagent cannot.')
  await $.session.compact({ trigger: 'precompute', messages: MESSAGES, agentId: 'a1' })
  expect(w.compactions).toEqual([{ trigger: 'precompute', instructions: undefined }])

  const report = await $.command.run(STATUS_COMMAND)
  expect(report.text).toContain('Health: working')
  expect(report.text).toContain(
    'Claude Code: 2.1.325\nSubagents: not asked on this Claude Code. That part needs 2.1.326 or later.',
  )
})

test("an agent list that fails leaves a subagent's tool call as it was", async ($, on) => {
  const w = world(on, { tokens: at(10), agents: [worker('a1', 950_000)], isAgentListBroken: true })
  await $.session.start(START)
  const ran = await workerCall($, 'a1')

  expect(ran.context ?? []).toEqual([])
  expect(w.sends).toEqual([])
  expect(last(w.statuses)).toContain('error in tool.call:')
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

test("instructions the person typed win, and a subagent gets none of the main conversation's", async ($, on) => {
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

test('no summary is computed ahead of time', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')

  const ahead = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  expect(ahead.skip).toContain('the summary is written when the compaction runs')
  expect(w.compactions).toEqual([])

  // Nor for a subagent: its instructions come late.
  const early = await $.session.compact({ trigger: 'precompute', messages: MESSAGES, agentId: 'a1' })
  expect(early.skip).toContain('the summary is written when the compaction runs')
  expect(w.compactions).toEqual([])

  // The proposal is still there for the compaction that comes.
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions[0]).toEqual({ trigger: 'auto', instructions: 'Keep the plan.' })
})

test('with no proposal a compaction runs unchanged', async ($, on) => {
  const w = world(on, { tokens: at(97) })
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: undefined }])
})

test('unattended, the mod compacts and tells the session to go on', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { tokens: at(85), settings: { isUnattended: true } })
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

test('the percentages are settings', async ($, on) => {
  mock.clock(on)
  world(on, { tokens: at(21), settings: { warn: percent(10), stop: percent(20) } })
  await $.session.start(START)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.context?.[0]).toContain('Stop at the next breakpoint')
})

test('a nudge set as a token count comes at that size', async ($, on) => {
  mock.clock(on)
  const w = world(on, {
    tokens: 249_000,
    settings: { warn: tokens(250_000), stop: tokens(300_000) },
  })
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

test('a failure inside the mod shows, and the tool call still answers', async ($, on) => {
  const w = world(on, { tokens: at(85) })
  await $.session.start(START)
  w.isUsageBroken = true
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBeUndefined()
  expect(last(w.statuses)).toContain('error in tool.call:')
  expect(last(w.toasts)).toContain('Error in tool.call:')
  expect(last(w.toasts)).toContain('Run /compact-warning for what to do.')
})

test('a /clear forgets the proposal', async ($, on) => {
  const w = world(on, { tokens: at(90) })
  await $.session.start(START)
  await propose($, 'Keep the plan.')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(w.compactions).toEqual([{ trigger: 'auto', instructions: undefined }])
})
