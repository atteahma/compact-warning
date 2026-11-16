import { expect, test } from 'claude-code/testing'

import {
  MAX_INSTRUCTIONS,
  cleanInstructions,
  compactLine,
  configOf,
  gaugeOf,
  hasShrunk,
  isStronger,
  levelOf,
  nudgeText,
  refusalOf,
  statusText,
} from '../hooks/logic'

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
  const base = { told: 'none', hasProposal: false, versionNote: undefined, lastError: undefined } as const

  expect(statusText({ ...base, gauge: null })).toBe('compact-warning on')
  expect(statusText({ ...base, gauge: gaugeOf(420, 1000) })).toBe('context 42% of auto-compact')
  expect(statusText({ ...base, gauge: gaugeOf(820, 1000), told: 'warn' })).toBe(
    'context 82% of auto-compact, looking for a breakpoint',
  )
  expect(statusText({ ...base, gauge: gaugeOf(900, 1000), told: 'stop', hasProposal: true })).toBe(
    'context 90% of auto-compact, /compact line ready',
  )
  expect(
    statusText({ ...base, gauge: null, versionNote: 'untested on Claude Code 9.9.9' }),
  ).toBe('compact-warning on · mod untested on Claude Code 9.9.9')
  expect(statusText({ ...base, gauge: null, lastError: 'tool.call: boom' })).toBe(
    'compact-warning on · mod error in tool.call: boom',
  )
})
