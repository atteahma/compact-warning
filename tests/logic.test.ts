import { expect, test } from 'claude-code/testing'
import type { AgentInfo, AgentStatus } from 'claude-code'

import {
  AIM_INSTRUCTIONS,
  DEFAULT_SETTINGS,
  INSTRUCTIONS_DESCRIPTION,
  MAX_INSTRUCTIONS,
  MAX_NAMED,
  MAX_SUBAGENT_ASKS,
  MIN_VERSION,
  SUBAGENTS_MIN_VERSION,
  SUBAGENT_ROOM,
  TOOL_DESCRIPTION,
  USAGE,
  ageOf,
  asksSubagents,
  cleanInstructions,
  compactLine,
  endedIn,
  errorToast,
  gaugeOf,
  greetingText,
  hasShrunk,
  healthText,
  installOf,
  instructionsFor,
  isAutoUpdated,
  isNoticeDue,
  isOlder,
  isStronger,
  isUnfinished,
  levelOf,
  nudgeText,
  offGreeting,
  offReport,
  readyHint,
  readyText,
  refusalOf,
  reportText,
  requestOf,
  runningOf,
  runningText,
  settingsOf,
  settingsText,
  statusText,
  stoppedOf,
  storedOf,
  storedText,
  subagentLimitOf,
  subagentNudgeText,
  subagentThresholdOf,
  subagentsLine,
  taskOf,
  thresholdsOf,
  toastText,
  tokensText,
  unfinishedOf,
  updateCommand,
  updatesText,
} from '../hooks/logic'
import type { Report, Settings, Task } from '../hooks/logic'

/** The auto-compaction point of a 1M window, and of a 200k window. */
const LARGE = 967_000
const SMALL = 167_000

const percent = (value: number) => ({ unit: 'percent', value }) as const
const tokens = (value: number) => ({ unit: 'tokens', value }) as const
const withSettings = (change: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...change })

test('the settings default to 80% and 88%, a reserve of 30 000 tokens, attended', () => {
  expect(settingsOf(undefined)).toEqual({
    warn: percent(80),
    stop: percent(88),
    reserveTokens: 30_000,
    isUnattended: false,
    isForSubagents: true,
  })
  expect(settingsText(DEFAULT_SETTINGS)).toBe(
    'warn 80%, stop 88%, reserve 30k, unattended off, subagents on',
  )
})

test('the store keeps only what the person changed, and a broken value is left out', () => {
  expect(settingsOf({ stop: tokens(300_000), isUnattended: true })).toEqual({
    warn: percent(80),
    stop: tokens(300_000),
    reserveTokens: 30_000,
    isUnattended: true,
    isForSubagents: true,
  })
  expect(
    storedOf({
      warn: percent(250),
      stop: { unit: 'tokens', value: 0 },
      reserveTokens: -5,
      isUnattended: 'yes',
      isForSubagents: 0,
      other: 1,
    }),
  ).toEqual({})
  expect(storedOf('not an object')).toEqual({})
  expect(storedOf({ reserveTokens: 0 })).toEqual({ reserveTokens: 0 })
  expect(storedOf({ isForSubagents: false })).toEqual({ isForSubagents: false })
})

test('the command reads a setting and its value', () => {
  expect(requestOf('')).toEqual({ kind: 'report' })
  expect(requestOf('  reset ')).toEqual({ kind: 'reset' })
  expect(requestOf('stop 300k')).toEqual({
    kind: 'set',
    change: { stop: tokens(300_000) },
    said: 'Set stop to 300k.',
  })
  expect(requestOf('WARN 75%')).toEqual({
    kind: 'set',
    change: { warn: percent(75) },
    said: 'Set warn to 75%.',
  })
  expect(requestOf('stop 1.2M')).toEqual({
    kind: 'set',
    change: { stop: tokens(1_200_000) },
    said: 'Set stop to 1.2M.',
  })
  expect(requestOf('reserve 20k')).toEqual({
    kind: 'set',
    change: { reserveTokens: 20_000 },
    said: 'Set reserve to 20k.',
  })
  expect(requestOf('reserve 0')).toEqual({
    kind: 'set',
    change: { reserveTokens: 0 },
    said: 'Set reserve to 0.',
  })
  expect(requestOf('unattended on')).toEqual({
    kind: 'set',
    change: { isUnattended: true },
    said: 'Set unattended to on.',
  })
  expect(requestOf('subagents off')).toEqual({
    kind: 'set',
    change: { isForSubagents: false },
    said: 'Set subagents to off.',
  })
})

test('the command refuses what it cannot read, and says why', () => {
  // A bare small number could be a percentage or a token count.
  expect(requestOf('stop 80')).toEqual({
    kind: 'refuse',
    why: 'Give stop a percentage such as 80%, or a token count such as 250k.',
  })
  expect(requestOf('warn 0%').kind).toBe('refuse')
  expect(requestOf('stop').kind).toBe('refuse')
  expect(requestOf('reserve lots')).toEqual({
    kind: 'refuse',
    why: 'Give reserve a token count such as 30k, or 0 for none.',
  })
  expect(requestOf('unattended maybe')).toEqual({
    kind: 'refuse',
    why: 'Give unattended the value on or off.',
  })
  expect(requestOf('subagents never')).toEqual({
    kind: 'refuse',
    why: 'Give subagents the value on or off.',
  })
  expect(requestOf('stop 300k now')).toEqual({ kind: 'refuse', why: 'Give one setting and one value.' })
  expect(requestOf('colour blue')).toEqual({ kind: 'refuse', why: 'There is no setting "colour".' })
  expect(USAGE).toContain('/compact-warning stop 88%')
  expect(USAGE).toContain('/compact-warning subagents off')
})

test('the subagent part needs a newer Claude Code than the rest, and says so', () => {
  expect(SUBAGENTS_MIN_VERSION).toBe('2.1.326')
  expect(asksSubagents(DEFAULT_SETTINGS, '2.1.325')).toBe(false)
  expect(asksSubagents(DEFAULT_SETTINGS, '2.1.326')).toBe(true)
  // A version that cannot be read holds nothing back.
  expect(asksSubagents(DEFAULT_SETTINGS, undefined)).toBe(true)
  expect(asksSubagents(withSettings({ isForSubagents: false }), '2.1.330')).toBe(false)

  expect(subagentsLine(DEFAULT_SETTINGS, '2.1.325')).toBe(
    'Subagents: not asked on this Claude Code. That part needs 2.1.326 or later.',
  )
  expect(subagentsLine(DEFAULT_SETTINGS, '2.1.326')).toBe(undefined)
  // Set to off, there is nothing to explain.
  expect(subagentsLine(withSettings({ isForSubagents: false }), '2.1.325')).toBe(undefined)

  const lines = reportText({ ...REPORT, engineVersion: '2.1.325' }).split('\n')
  expect(lines[5]).toBe('Claude Code: 2.1.325')
  expect(lines[6]).toBe('Subagents: not asked on this Claude Code. That part needs 2.1.326 or later.')
})

test('a subagent is compacted where the main conversation would be, in its own window', () => {
  const large = { window: 1_000_000, compactWindow: 1_000_000, point: LARGE }
  const small = { window: 200_000, compactWindow: 200_000, point: SMALL }

  expect(subagentLimitOf(large, 1_000_000)).toBe(LARGE)
  // A subagent on a model with a smaller window, and one with a larger.
  expect(subagentLimitOf(large, 200_000)).toBe(SMALL)
  expect(subagentLimitOf(small, 1_000_000)).toBe(LARGE)
  // A window the engine does not name counts as the main conversation's.
  expect(subagentLimitOf(large, undefined)).toBe(LARGE)
  // A compaction window that was set for the session holds for a subagent too.
  expect(subagentLimitOf({ window: 1_000_000, compactWindow: 100_000, point: 67_000 }, 1_000_000)).toBe(
    67_000,
  )
})

test('a subagent is asked 50 000 tokens before its compaction, on a small window a quarter before', () => {
  expect(SUBAGENT_ROOM).toBe(50_000)
  expect(subagentThresholdOf(LARGE)).toBe(917_000)
  expect(subagentThresholdOf(SMALL)).toBe(125_250)
  expect(subagentThresholdOf(67_000)).toBe(50_250)
})

test('the message for a subagent asks for instructions and for no stop, and the second is a reminder', () => {
  const note = subagentNudgeText(gaugeOf(920_000, LARGE))

  expect(note).toContain(
    '[compact-warning] From compact-warning, a Claude Code mod that the user installed.',
  )
  expect(note).toContain("This subagent's context is at 95% of the point")
  expect(note).toContain('(920k of 967k tokens)')
  expect(note).toContain('call the tool mcp__compact-warning__propose_compact before your next step')
  expect(note).toContain('If you do not have the tool, ignore this message. After the call, keep working.')
  expect(note).not.toContain('breakpoint')
  expect(note).not.toContain('end your turn')
  // A request to keep quiet about the message reads like an injected instruction.
  expect(note).not.toContain('report')

  const again = subagentNudgeText(gaugeOf(930_000, LARGE), 2)
  expect(again).toContain('[compact-warning] A reminder from the compact-warning mod: the tool mcp__compact-warning__propose_compact has not been called')
  expect(again).toContain('(930k of 967k tokens)')
  expect(again).toContain('After the call, keep working.')
  expect(MAX_SUBAGENT_ASKS).toBe(2)
  expect(TOOL_DESCRIPTION).toContain('A subagent calls it when a message that begins with [compact-warning] asks for it')
})

test('a Claude Code older than the floor is told apart', () => {
  expect(MIN_VERSION).toBe('2.1.325')
  expect(isOlder('2.1.311', MIN_VERSION)).toBe(true)
  expect(isOlder('2.0.999', MIN_VERSION)).toBe(true)
  expect(isOlder('2.1.324', MIN_VERSION)).toBe(true)
  expect(isOlder('2.1.325', MIN_VERSION)).toBe(false)
  expect(isOlder('2.1.328', MIN_VERSION)).toBe(false)
  expect(isOlder('2.2.0', MIN_VERSION)).toBe(false)
  expect(isOlder('3.0.0', MIN_VERSION)).toBe(false)
  // A development build counts by the release it is built from.
  expect(isOlder('2.1.311-dev.20261026.t101500.sha1a2b3c4', MIN_VERSION)).toBe(true)
  // A version that cannot be read turns nothing off.
  expect(isOlder('nightly', MIN_VERSION)).toBe(false)
})

test('below the floor the start line and the report say that the mod is off', () => {
  expect(offGreeting('2.1.311')).toEqual({
    text: 'compact-warning is off',
    detail: ' · needs Claude Code 2.1.325 or later, this is 2.1.311',
    isOff: true,
  })
  expect(offReport('2.1.311')).toBe(
    'Health: off, needs Claude Code 2.1.325 or later, this is 2.1.311\nUpdate Claude Code to turn the mod on. Its stable channel gets a version later than its latest channel.',
  )
})

test('on a large window the nudges come at their percentages', () => {
  expect(thresholdsOf(LARGE, DEFAULT_SETTINGS)).toEqual({ warn: 773_600, stop: 850_960 })
})

test('on a small window both nudges come earlier, and the reserve remains', () => {
  // 88% would leave 20 040 tokens. Both nudges move 9 960 tokens earlier.
  expect(thresholdsOf(SMALL, DEFAULT_SETTINGS)).toEqual({ warn: 123_640, stop: 137_000 })
  expect(thresholdsOf(SMALL, withSettings({ reserveTokens: 0 }))).toEqual({
    warn: 133_600,
    stop: 146_960,
  })
  // The reserve takes a quarter of the limit at most.
  expect(thresholdsOf(60_000, DEFAULT_SETTINGS).stop).toBe(45_000)
})

test('a nudge set as a token count comes at that size', () => {
  const settings = withSettings({ warn: tokens(250_000), stop: tokens(300_000) })

  expect(thresholdsOf(LARGE, settings)).toEqual({ warn: 250_000, stop: 300_000 })
  // It never comes later than its default percentage: a small window is covered.
  expect(thresholdsOf(SMALL, settings)).toEqual({ warn: 123_640, stop: 137_000 })
})

test('the first nudge never comes after the second', () => {
  expect(thresholdsOf(LARGE, withSettings({ stop: tokens(300_000) }))).toEqual({
    warn: 300_000,
    stop: 300_000,
  })
  expect(thresholdsOf(LARGE, withSettings({ warn: percent(90), stop: percent(70) }))).toEqual({
    warn: 676_900,
    stop: 676_900,
  })
})

test('the level follows the nudges', () => {
  const thresholds = thresholdsOf(LARGE, DEFAULT_SETTINGS)

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
  expect(refusalOf('keep the plan')).toBeUndefined()
  expect(compactLine('keep the plan')).toBe('/compact keep the plan')
})

test('instructions over the aim pass, and only a runaway draft is refused', () => {
  expect(AIM_INSTRUCTIONS).toBe(3000)
  expect(MAX_INSTRUCTIONS).toBe(4500)
  // The model is told the aim, never the limit: it writes up to the number it is given.
  expect(INSTRUCTIONS_DESCRIPTION).toContain('Aim for 3000 characters or fewer')
  expect(INSTRUCTIONS_DESCRIPTION).not.toContain('4500')
  // The longest first draft in 49 real proposals was 4858 characters against an aim of 4000:
  // a fifth over. The same overshoot of this aim is 3600.
  expect(refusalOf('x'.repeat(3600))).toBeUndefined()
  expect(refusalOf('x'.repeat(4500))).toBeUndefined()
  expect(refusalOf('x'.repeat(4501))).toBe(
    'The instructions are 4501 characters long, and the aim is 3000. Cut them by about 40%: point at the state document instead of repeating it.',
  )
  expect(refusalOf('x'.repeat(9000))).toContain('Cut them by about 70%')
})

test('the notice about updates is due once, for a copy updated by hand', () => {
  const byHand = { marketplace: 'compact-warning', isAutomatic: false }

  expect(isNoticeDue(byHand, undefined)).toBe(true)
  expect(isNoticeDue(byHand, true)).toBe(false)
  expect(isNoticeDue({ ...byHand, isAutomatic: true }, undefined)).toBe(false)
  // A copy that Claude Code reads from a folder has no updates to speak of.
  expect(isNoticeDue(undefined, undefined)).toBe(false)
})

test('the toast says what Claude is doing', () => {
  expect(toastText('warn', gaugeOf(820, 1000))).toBe(
    'Context at 82% of auto-compact. Claude is looking for a breakpoint.',
  )
  expect(toastText('stop', gaugeOf(900, 1000))).toBe(
    'Context at 90% of auto-compact. Claude will stop at the next breakpoint.',
  )
  expect(errorToast('tool.call: boom')).toBe(
    'Error in tool.call: boom. Run /compact-warning for what to do.',
  )
})

test('the status line says what the mod is doing', () => {
  const base = { told: 'none', hasProposal: false, age: 0, lastError: undefined } as const

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
  expect(statusText({ ...base, gauge: null, lastError: 'tool.call: boom' })).toBe(
    'error in tool.call: boom',
  )
  expect(statusText({ ...base, gauge: gaugeOf(420, 1000), lastError: 'tool.call: boom' })).toBe(
    'context at 42% of auto-compact · error in tool.call: boom',
  )
})

test('the green line names the nudges and the auto-compaction point', () => {
  expect(greetingText(LARGE, true, thresholdsOf(LARGE, DEFAULT_SETTINGS))).toEqual({
    text: '✓ compact-warning is working',
    detail: ' · nudges at 774k and 851k tokens · auto-compact at 967k',
    isOff: false,
  })
  expect(greetingText(SMALL, true, thresholdsOf(SMALL, DEFAULT_SETTINGS)).detail).toBe(
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
  settings: DEFAULT_SETTINGS,
  engineVersion: '2.1.326',
  updates: undefined,
  lastError: undefined,
}

test('the report opens with the verdict of the checks, and what to do', () => {
  expect(healthText(undefined)).toBe('Health: working')
  expect(healthText('tool.call: boom')).toBe(
    'Health: needs attention, error in tool.call: boom\nFor a fix, run: claude plugin update compact-warning@compact-warning',
  )
})

test('a copy from a marketplace knows where it came from, and a folder does not', () => {
  expect(installOf('/Users/sam/.claude/plugins/cache/compact-warning/compact-warning/0.2.1')).toEqual({
    configDir: '/Users/sam/.claude',
    marketplace: 'compact-warning',
  })
  // Another name for the marketplace, a version that is a commit, and Windows.
  expect(installOf('/home/sam/cfg/plugins/cache/sams-mods/compact-warning/3a448eea1907/')).toEqual({
    configDir: '/home/sam/cfg',
    marketplace: 'sams-mods',
  })
  expect(
    installOf('C:\\Users\\sam\\.claude\\plugins\\cache\\compact-warning\\compact-warning\\0.2.1'),
  ).toEqual({ configDir: 'C:\\Users\\sam\\.claude', marketplace: 'compact-warning' })
  // Read in place: a clone, or a folder named at the start.
  expect(installOf('/Users/sam/repos/compact-warning')).toBeUndefined()
  expect(installOf('/Users/sam/.claude/plugins/cache')).toBeUndefined()
})

test('updates are automatic only where a setting says so, and the settings win', () => {
  const on = { 'compact-warning': { source: { source: 'github' }, autoUpdate: true } }
  const off = { 'compact-warning': { source: { source: 'github' }, autoUpdate: false } }
  const unset = { 'compact-warning': { source: { source: 'github' } } }

  expect(isAutoUpdated('compact-warning', on, undefined)).toBe(true)
  expect(isAutoUpdated('compact-warning', unset, on)).toBe(true)
  expect(isAutoUpdated('compact-warning', off, on)).toBe(false)
  expect(isAutoUpdated('compact-warning', unset, unset)).toBe(false)
  expect(isAutoUpdated('compact-warning', undefined, 'broken')).toBe(false)
  // Another marketplace's switch says nothing about this one.
  expect(isAutoUpdated('sams-mods', on, on)).toBe(false)
})

test('the report says how updates arrive, and names the marketplace in the fix', () => {
  const byHand = { marketplace: 'sams-mods', isAutomatic: false }

  expect(updatesText({ marketplace: 'compact-warning', isAutomatic: true })).toBe('Updates: automatic')
  expect(updatesText(byHand)).toBe(
    'Updates: by hand. For fixes by themselves: /plugin, Marketplaces, sams-mods, Turn on auto-update',
  )
  expect(updateCommand()).toBe('claude plugin update compact-warning@compact-warning')
  expect(healthText('tool.call: boom', 'sams-mods')).toContain(
    'For a fix, run: claude plugin update compact-warning@sams-mods',
  )

  const lines = reportText({ ...REPORT, updates: byHand }).split('\n')
  expect(lines[5]).toBe('Claude Code: 2.1.326')
  expect(lines[6]).toBe(updatesText(byHand))
  expect(lines[7]).toBe('Proposal: none')
})

test('the report is one fact to a line', () => {
  expect(reportText(REPORT)).toBe(
    [
      'Health: working',
      'Context: 116k of 967k tokens, 12% of auto-compact',
      'Nudges: at 774k and 851k tokens, none sent yet',
      'Settings: warn 80%, stop 88%, reserve 30k, unattended off, subagents on',
      'To change one: /compact-warning stop 300k',
      'Claude Code: 2.1.326',
      'Proposal: none',
    ].join('\n'),
  )

  const waiting = reportText({
    ...REPORT,
    gauge: gaugeOf(880_000, LARGE),
    told: 'stop',
    settings: withSettings({ stop: tokens(860_000), isUnattended: true }),
    proposal: { instructions: 'Keep the plan.', tokens: 860_000, isHandedOver: true },
  })

  expect(waiting).toContain('Nudges: at 774k and 851k tokens, second sent')
  expect(waiting).toContain('Settings: warn 80%, stop 860k, reserve 30k, unattended on, subagents on\n')
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
