// The mod's decisions and wording, with no engine calls: register.tsx wires
// these to the session, and logic.test.ts checks them alone.

import type { Gauge, Proposal, Told } from '../types'

export const TOOL_NAME = 'propose_compact'
/** The tool's full name, as the model calls it. */
export const TOOL = 'mcp__compact-warning__propose_compact'
export const COMMAND = 'compact-warning'

/** The longest instructions the tool takes, in characters. */
export const MAX_INSTRUCTIONS = 4000

/** Growth of the context, in tokens, after which a stored proposal is old. */
export const STALE_TOKENS = 5000

/** How far under the first threshold the fill must fall to count as shrunk. */
export const RESET_MARGIN = 5

const DEFAULT_WARN = 80
const DEFAULT_STOP = 88
const MIN_PERCENT = 1
const MAX_PERCENT = 99

export type Config = {
  warnPercent: number
  stopPercent: number
  isUnattended: boolean
}

type Options = Readonly<Record<string, unknown>>

function percentOf(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(n)))
}

/** Reads the options, and keeps the second threshold at or above the first. */
export function configOf(options: Options): Config {
  const warnPercent = percentOf(options['warnPercent'], DEFAULT_WARN)
  const stopPercent = percentOf(options['stopPercent'], DEFAULT_STOP)

  return {
    warnPercent,
    stopPercent: Math.max(warnPercent, stopPercent),
    isUnattended: options['unattended'] === true,
  }
}

export function gaugeOf(tokens: number, limit: number): Gauge {
  const safeLimit = limit > 0 ? limit : 1

  return { tokens, limit: safeLimit, percent: Math.floor((100 * tokens) / safeLimit) }
}

export function levelOf(percent: number, config: Config): Told {
  if (percent >= config.stopPercent) {
    return 'stop'
  }

  return percent >= config.warnPercent ? 'warn' : 'none'
}

const RANK: Readonly<Record<Told, number>> = { none: 0, warn: 1, stop: 2 }

export function isStronger(level: Told, than: Told): boolean {
  return RANK[level] > RANK[than]
}

/** True when the context is so far under the first threshold that it shrank. */
export function hasShrunk(percent: number, config: Config): boolean {
  return percent < config.warnPercent - RESET_MARGIN
}

function count(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function where(gauge: Gauge): string {
  return `${gauge.percent}% of the point where auto-compaction fires (${count(gauge.tokens)} of ${count(gauge.limit)} tokens)`
}

const BREAKPOINT =
  'A good breakpoint: verified work is committed, no command is half-run, and no subagent or background task is about to report.'

const HAND_OVER = `At the breakpoint, write the session's state where the project keeps it (its status document, a commit). Then call the tool ${TOOL} with the instructions for the summary, and end your turn. Load the tool with ToolSearch if its schema is not loaded.`

/** What the model reads when the fill crosses a threshold. */
export function nudgeText(level: 'warn' | 'stop', gauge: Gauge, hasProposal: boolean): string {
  const head = `[compact-warning] The context is at ${where(gauge)}.`
  const again = hasProposal
    ? ' A proposal is already stored: call the tool again only if the state has changed since.'
    : ''

  if (level === 'warn') {
    return `${head} Keep working, and look for a good breakpoint. ${BREAKPOINT} ${HAND_OVER} If you have a compaction rule (compact-breakpoint), follow it.${again}`
  }

  return `${head} Stop at the next breakpoint, and start no new piece of work. ${BREAKPOINT} ${HAND_OVER}${again}`
}

/** What the model reads with a prompt while an offered proposal is unused. */
export const STALE_NOTE = `[compact-warning] A compaction proposal from earlier in this session is stored and unused. A later compaction will use it. If this turn changes the state it describes, call ${TOOL} again with new instructions before you end the turn.`

export function toastText(level: 'warn' | 'stop', gauge: Gauge): string {
  return level === 'warn'
    ? `Context is at ${gauge.percent}% of the auto-compaction point. Claude is looking for a breakpoint.`
    : `Context is at ${gauge.percent}% of the auto-compaction point. Claude will stop at the next breakpoint.`
}

/** Trims the instructions and closes up runs of blank lines. */
export function cleanInstructions(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\n{3,}/g, '\n\n') : ''
}

/** Why the instructions cannot be stored, or undefined when they can. */
export function refusalOf(instructions: string): string | undefined {
  if (instructions === '') {
    return 'Give `instructions`: what the summary must keep, most important first, and what to drop.'
  }

  if (instructions.length > MAX_INSTRUCTIONS) {
    return `The instructions are ${instructions.length} characters long. Shorten them to ${MAX_INSTRUCTIONS} or fewer: point at the state document instead of repeating it.`
  }

  return undefined
}

/** How many tokens the context has grown since the proposal; 0 when unknown. */
export function ageOf(proposal: Proposal | null, gauge: Gauge | null): number {
  if (proposal === null || proposal.tokens === null || gauge === null) {
    return 0
  }

  return Math.max(0, gauge.tokens - proposal.tokens)
}

function ageText(age: number): string {
  return `${count(Math.round(age / 1000) * 1000)} tokens`
}

/**
 * The instructions as a compaction gets them. Once the conversation has moved
 * on since they were written, the summary is told so.
 */
export function instructionsFor(proposal: Proposal, gauge: Gauge | null): string {
  const age = ageOf(proposal, gauge)

  return age < STALE_TOKENS
    ? proposal.instructions
    : `${proposal.instructions}\n\n(These instructions were written about ${ageText(age)} of conversation ago. Where the later conversation differs from them, the later conversation wins.)`
}

export function compactLine(instructions: string): string {
  return `/compact ${instructions}`
}

export function storedText(gauge: Gauge | null, isUnattended: boolean): string {
  const at = gauge === null ? '' : ` The context is at ${where(gauge)}.`
  const then = isUnattended
    ? 'End your turn now. The mod compacts the conversation with these instructions when the turn ends, then sends you a prompt to continue.'
    : 'End your turn now, with one or two lines for the user. The mod puts the /compact line with these instructions in the prompt box, and the user presses Enter. An automatic compaction uses them too.'

  return `Stored.${at} ${then}`
}

/** Why the mod refuses a summary that the engine wants to compute ahead of time. */
export const PRECOMPUTE_SKIP =
  'compact-warning: the summary is written when the compaction runs, so that it follows the instructions of that moment.'

export const RESUME_PROMPT =
  'The conversation was compacted with your own instructions. Read the state you wrote down, then continue the work.'

export type Status = {
  gauge: Gauge | null
  told: Told
  hasProposal: boolean
  /** Tokens the context has grown since the proposal was stored. */
  age: number
  versionNote: string | undefined
  lastError: string | undefined
}

/**
 * The line under the prompt, or undefined for none. The engine draws it as a
 * warning, so it is there only when there is something to act on: a threshold
 * was crossed, a /compact line waits, or the mod has a fault.
 */
export function statusText(status: Status): string | undefined {
  const { gauge, told, hasProposal, age, versionNote, lastError } = status
  const old = age < STALE_TOKENS ? '' : `, ${ageText(age)} old`
  const state = hasProposal
    ? `/compact line ready${old}`
    : told === 'stop'
      ? 'stopping at the next breakpoint'
      : told === 'warn'
        ? 'looking for a breakpoint'
        : undefined

  if (state === undefined && versionNote === undefined && lastError === undefined) {
    return undefined
  }

  // The engine draws the mod's name in front of this text.
  const fill = gauge === null ? undefined : `context ${gauge.percent}% of auto-compact`
  const head = [fill, state].filter(part => part !== undefined).join(', ')
  const version = versionNote === undefined ? undefined : `mod ${versionNote}`
  const error = lastError === undefined ? undefined : `mod error in ${lastError}`

  return [head, version, error].filter(part => part !== undefined && part !== '').join(' · ')
}

function thresholds(config: Config): string {
  return config.warnPercent === config.stopPercent
    ? `${config.warnPercent}%`
    : `${config.warnPercent}% and ${config.stopPercent}%`
}

/** The green line above the prompt once the start check has passed. */
export function greetingText(gauge: Gauge | null, limit: number, config: Config): string {
  const now = gauge === null ? '' : ` The context is at ${gauge.percent}% now.`

  return `✓ compact-warning is working. It warns at ${thresholds(config)} of the auto-compaction point (${count(limit)} tokens).${now}`
}

/** The first line of the report: the verdict of the checks. */
export function healthText(
  engineVersion: string | undefined,
  versionNote: string | undefined,
  lastError: string | undefined,
): string {
  if (lastError !== undefined) {
    return `Health: needs attention. A hook of the mod failed in ${lastError}.`
  }

  if (versionNote !== undefined) {
    return `Health: needs attention. The mod has not passed its tests on Claude Code ${engineVersion ?? 'this version'}. Run tools/check in its folder.`
  }

  return 'Health: working. The version is tested, the context reading answers, and no hook has failed.'
}

export type Report = {
  gauge: Gauge | null
  told: Told
  proposal: Proposal | null
  config: Config
  engineVersion: string | undefined
  versionNote: string | undefined
  lastError: string | undefined
}

const TOLD_WORDS: Readonly<Record<Told, string>> = {
  none: 'none',
  warn: 'look for a breakpoint',
  stop: 'stop at the next breakpoint',
}

/** What /compact-warning prints. */
export function reportText(report: Report): string {
  const { gauge, told, proposal, config, engineVersion, versionNote, lastError } = report
  const version = engineVersion ?? 'an unknown version'
  const tested =
    versionNote === undefined ? 'its tests passed on this version' : 'its tests have not passed on this version'
  const context = gauge === null ? 'no reading yet' : `at ${where(gauge)}`
  const age = ageOf(proposal, gauge)
  const old = age < STALE_TOKENS ? '' : `, ${ageText(age)} old`
  const stored =
    proposal === null
      ? 'none stored.'
      : `stored, ${proposal.isHandedOver ? 'offered to you' : 'not offered yet'}${old}:\n${proposal.instructions}`

  return [
    healthText(engineVersion, versionNote, lastError),
    `Running on Claude Code ${version}: ${tested}.`,
    `Context: ${context}.`,
    `Nudges: look for a breakpoint at ${config.warnPercent}%, stop at ${config.stopPercent}%. Given so far: ${TOLD_WORDS[told]}.`,
    `Compact without asking: ${config.isUnattended ? 'on' : 'off'}.`,
    `Last error: ${lastError ?? 'none'}.`,
    `Proposal: ${stored}`,
  ].join('\n')
}

export const TOOL_DESCRIPTION =`Proposes a compaction of this conversation at a good breakpoint. Call it only in the main conversation, after you have written the session's state where the project keeps it (its status document, a commit). ${BREAKPOINT} After the call, end your turn: the user gets a ready /compact line with your instructions, and an automatic compaction uses them too.`

export const INSTRUCTIONS_DESCRIPTION = `What the summary must keep, most important first, then what to drop. A shape that works: (1) your role and the agreed plan, with what not to start; (2) where the truth is: the document and section to read first after the compaction; (3) the live state: what is running, by id, and what to do when each finishes; (4) the exact commands of any repeated step; (5) the nevers; (6) what is still owed; (7) the user's decisions that shape everything; (8) drop: content already written into documents, tool output, back-and-forth. At most ${MAX_INSTRUCTIONS} characters.`
