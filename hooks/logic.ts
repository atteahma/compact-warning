// The mod's decisions and wording, with no engine calls: register.tsx wires
// these to the session, and logic.test.ts checks them alone.

import type { AgentInfo, AgentStatus } from 'claude-code'

import type { Gauge, Proposal, Told } from '../types'

export const TOOL_NAME = 'propose_compact'
/** The tool's full name, as the model calls it. */
export const TOOL = 'mcp__compact-warning__propose_compact'
export const COMMAND = 'compact-warning'

/**
 * The length of instructions the model is told to aim for, in characters.
 * It writes up to the number it is given, and over it by up to a fifth.
 */
export const AIM_INSTRUCTIONS = 3000

/**
 * The longest instructions the tool takes. The model is not told this number:
 * it is room for the overshoot, so that a draft is not written twice when the
 * context is nearly full.
 */
export const MAX_INSTRUCTIONS = 4500

/** Growth of the context, in tokens, after which a stored proposal is old. */
export const STALE_TOKENS = 5000

/**
 * How far under the first nudge the fill must fall to count as shrunk, in
 * percent of the limit.
 */
export const RESET_MARGIN = 5

const DEFAULT_WARN = 80
const DEFAULT_STOP = 88
const DEFAULT_RESERVE = 30_000
const MIN_PERCENT = 1
const MAX_PERCENT = 99
/** The largest share of the limit that the reserve may take. */
const MAX_RESERVE_SHARE = 0.25
/**
 * The oldest Claude Code the mod runs on. The manifest's `engines` states the
 * same floor, but a Claude Code older than 2.1.323 does not read it.
 */
export const MIN_VERSION = '2.1.325'

const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)/

/** True when `version` is older than `floor`; false when either is unreadable. */
export function isOlder(version: string, floor: string): boolean {
  const ours = VERSION_PARTS.exec(version)?.slice(1).map(Number)
  const theirs = VERSION_PARTS.exec(floor)?.slice(1).map(Number)

  if (ours === undefined || theirs === undefined) {
    return false
  }

  const at = ours.findIndex((part, index) => part !== theirs[index])

  return at !== -1 && (ours[at] ?? 0) < (theirs[at] ?? 0)
}

/** Why the mod is off on a Claude Code older than its floor. */
export function floorText(version: string): string {
  return `needs Claude Code ${MIN_VERSION} or later, this is ${version}`
}

/** Where a nudge comes: at a percentage of the limit, or at a context size. */
export type Mark = { unit: 'percent' | 'tokens'; value: number }

export type Settings = {
  warn: Mark
  stop: Mark
  /** The room, in tokens, kept before the limit for the hand-over; 0 for none. */
  reserveTokens: number
  isUnattended: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  warn: { unit: 'percent', value: DEFAULT_WARN },
  stop: { unit: 'percent', value: DEFAULT_STOP },
  reserveTokens: DEFAULT_RESERVE,
  isUnattended: false,
}

/** The store's key for the settings. */
export const SETTINGS_KEY = 'settings'

/**
 * What the store holds: only what the person changed, so that a setting they
 * never touched follows the default of a later version.
 */
export type StoredSettings = Partial<Settings>

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function markOf(value: unknown): Mark | undefined {
  const unit = field(value, 'unit')
  const size = field(value, 'value')

  if (!isCount(size)) {
    return undefined
  }

  if (unit === 'percent') {
    return size >= MIN_PERCENT && size <= MAX_PERCENT ? { unit, value: size } : undefined
  }

  return unit === 'tokens' && size > 0 ? { unit, value: size } : undefined
}

/** The stored settings that are well formed: the store outlives a version. */
export function storedOf(value: unknown): StoredSettings {
  const warn = markOf(field(value, 'warn'))
  const stop = markOf(field(value, 'stop'))
  const reserveTokens = field(value, 'reserveTokens')
  const isUnattended = field(value, 'isUnattended')

  return {
    ...(warn === undefined ? {} : { warn }),
    ...(stop === undefined ? {} : { stop }),
    ...(isCount(reserveTokens) ? { reserveTokens } : {}),
    ...(typeof isUnattended === 'boolean' ? { isUnattended } : {}),
  }
}

/** The settings in force: the defaults, with what the person changed. */
export function settingsOf(value: unknown): Settings {
  return { ...DEFAULT_SETTINGS, ...storedOf(value) }
}

const PERCENT = /^(\d{1,2})%$/
const TOKENS = /^(\d+(?:\.\d+)?)([km])?$/i

function countIn(text: string): number | undefined {
  const found = TOKENS.exec(text)

  if (found === null) {
    return undefined
  }

  const unit = found[2]?.toLowerCase()
  const scale = unit === 'k' ? THOUSAND : unit === 'm' ? MILLION : 1

  return Math.round(Number(found[1]) * scale)
}

function markIn(text: string): Mark | undefined {
  const percent = PERCENT.exec(text)?.[1]

  if (percent !== undefined) {
    return markOf({ unit: 'percent', value: Number(percent) })
  }

  const tokens = countIn(text)

  // A bare small number could be a percentage or a token count: neither is taken.
  return tokens === undefined || tokens < THOUSAND ? undefined : { unit: 'tokens', value: tokens }
}

function markText(mark: Mark): string {
  return mark.unit === 'percent' ? `${mark.value}%` : tokensText(mark.value)
}

/** What `/compact-warning <args>` asks for. */
export type Request =
  | { kind: 'report' }
  | { kind: 'reset' }
  | { kind: 'set'; change: StoredSettings; said: string }
  | { kind: 'refuse'; why: string }

export const USAGE = [
  'Settings:',
  `/${COMMAND} warn 80%: the first nudge, as a percentage of the limit or a token count (250k)`,
  `/${COMMAND} stop 88%: the second nudge`,
  `/${COMMAND} reserve 30k: room kept for the hand-over on a small window`,
  `/${COMMAND} unattended on: compact without asking`,
  `/${COMMAND} reset: back to the defaults`,
].join('\n')

/** Reads what the person typed after the command's name. */
export function requestOf(args: string): Request {
  const [name = '', value = '', ...rest] = args.trim().toLowerCase().split(/\s+/)

  if (name === '') {
    return { kind: 'report' }
  }

  if (name === 'reset' && value === '') {
    return { kind: 'reset' }
  }

  if (rest.length > 0) {
    return { kind: 'refuse', why: 'Give one setting and one value.' }
  }

  if (name === 'warn' || name === 'stop') {
    const mark = markIn(value)

    return mark === undefined
      ? { kind: 'refuse', why: `Give ${name} a percentage such as 80%, or a token count such as 250k.` }
      : { kind: 'set', change: { [name]: mark }, said: `Set ${name} to ${markText(mark)}.` }
  }

  if (name === 'reserve') {
    const tokens = countIn(value)

    return tokens === undefined
      ? { kind: 'refuse', why: 'Give reserve a token count such as 30k, or 0 for none.' }
      : { kind: 'set', change: { reserveTokens: tokens }, said: `Set reserve to ${tokensText(tokens)}.` }
  }

  if (name === 'unattended') {
    return value === 'on' || value === 'off'
      ? { kind: 'set', change: { isUnattended: value === 'on' }, said: `Set unattended to ${value}.` }
      : { kind: 'refuse', why: 'Give unattended the value on or off.' }
  }

  return { kind: 'refuse', why: `There is no setting "${name}".` }
}

/** The settings in one line, as the report and the README write them. */
export function settingsText(settings: Settings): string {
  return [
    `warn ${markText(settings.warn)}`,
    `stop ${markText(settings.stop)}`,
    `reserve ${tokensText(settings.reserveTokens)}`,
    `unattended ${settings.isUnattended ? 'on' : 'off'}`,
  ].join(', ')
}

/** Where the two nudges come, in tokens of context. */
export type Thresholds = { warn: number; stop: number }

/**
 * Where the nudges come for a limit. A nudge set as a percentage comes at
 * that share of the limit. One set as a token count comes at that size, and
 * never later than its default percentage, so a small window is still covered.
 *
 * On a small window the percentages leave too little room to hand over in.
 * Both nudges then come earlier by the same amount, so that the reserve
 * remains after the second. The first never comes after the second.
 */
export function thresholdsOf(limit: number, settings: Settings): Thresholds {
  const share = (percent: number): number => Math.ceil((limit * percent) / 100)
  const asked = (mark: Mark, fallback: number): number =>
    mark.unit === 'percent' ? share(mark.value) : Math.min(mark.value, share(fallback))
  const stopAsked = asked(settings.stop, DEFAULT_STOP)
  const warnAsked = asked(settings.warn, DEFAULT_WARN)
  const reserve = Math.min(settings.reserveTokens, Math.floor(limit * MAX_RESERVE_SHARE))
  const shift = Math.max(0, stopAsked - (limit - reserve))
  const stop = stopAsked - shift

  return { warn: Math.max(0, Math.min(warnAsked - shift, stop)), stop }
}

export function gaugeOf(tokens: number, limit: number, isAutoCompact = true): Gauge {
  const safeLimit = limit > 0 ? limit : 1

  return {
    tokens,
    limit: safeLimit,
    percent: Math.floor((100 * tokens) / safeLimit),
    isAutoCompact,
  }
}

export function levelOf(tokens: number, thresholds: Thresholds): Told {
  if (tokens >= thresholds.stop) {
    return 'stop'
  }

  return tokens >= thresholds.warn ? 'warn' : 'none'
}

const RANK: Readonly<Record<Told, number>> = { none: 0, warn: 1, stop: 2 }

export function isStronger(level: Told, than: Told): boolean {
  return RANK[level] > RANK[than]
}

/** True when the context is so far under the first nudge that it shrank. */
export function hasShrunk(gauge: Gauge, thresholds: Thresholds): boolean {
  return gauge.tokens < thresholds.warn - (gauge.limit * RESET_MARGIN) / 100
}

const THOUSAND = 1000
const MILLION = 1_000_000

/** A token count as Claude Code writes one: 850, 774k, 1.25M. */
export function tokensText(tokens: number): string {
  const whole = Math.max(0, Math.round(tokens))

  if (whole < THOUSAND) {
    return String(whole)
  }

  const thousands = Math.round(whole / THOUSAND)

  return thousands < THOUSAND ? `${thousands}k` : `${Number((whole / MILLION).toFixed(2))}M`
}

/**
 * True unless auto-compaction is off, and the limit is the whole window. A
 * reading that an older version of the mod stored counts as on.
 */
function isAuto(gauge: Gauge): boolean {
  return gauge.isAutoCompact !== false
}

function sizes(gauge: Gauge): string {
  return `${tokensText(gauge.tokens)} of ${tokensText(gauge.limit)} tokens`
}

/** The fill as a sentence for the model. */
function where(gauge: Gauge): string {
  return isAuto(gauge)
    ? `The context is at ${gauge.percent}% of the point where auto-compaction fires (${sizes(gauge)}).`
    : `The context window is ${gauge.percent}% full (${sizes(gauge)}), and auto-compaction is off.`
}

/** The fill in a few words for the person. */
function fill(gauge: Gauge): string {
  return isAuto(gauge)
    ? `context at ${gauge.percent}% of auto-compact`
    : `context window ${gauge.percent}% full`
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const BREAKPOINT =
  'A good breakpoint: verified work is committed, no command is half-run, and no subagent or background task is about to report.'

const HAND_OVER = `At the breakpoint, write the session's state where the project keeps it (a status document, a commit). If the project has no such place, create none: let your instructions say what state the summary must keep. Then call the tool ${TOOL} with the instructions for the summary, and end your turn. Load the tool with ToolSearch if its schema is not loaded.`

/** What the model reads when the fill reaches a nudge. */
export function nudgeText(level: 'warn' | 'stop', gauge: Gauge, hasProposal: boolean): string {
  const head = `[compact-warning] ${where(gauge)}`
  const again = hasProposal
    ? ' A proposal is already stored: call the tool again only if the state has changed since.'
    : ''
  const ask =
    level === 'warn'
      ? 'Keep working, and look for a good breakpoint.'
      : 'Stop at the next breakpoint, and start no new piece of work.'

  return `${head} ${ask} ${BREAKPOINT} ${HAND_OVER}${again}`
}

/** What the model reads with a prompt while an offered proposal is unused. */
export const STALE_NOTE = `[compact-warning] A compaction proposal from earlier in this session is stored and unused. A later compaction will use it. If this turn changes the state it describes, call ${TOOL} again with new instructions before you end the turn.`

export function toastText(level: 'warn' | 'stop', gauge: Gauge): string {
  const doing =
    level === 'warn' ? 'Claude is looking for a breakpoint.' : 'Claude will stop at the next breakpoint.'

  return `${capitalized(fill(gauge))}. ${doing}`
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
    // A share to cut is easier to hit than a count of characters.
    const cut = Math.ceil((10 * (instructions.length - AIM_INSTRUCTIONS)) / instructions.length) * 10

    return `The instructions are ${instructions.length} characters long, and the aim is ${AIM_INSTRUCTIONS}. Cut them by about ${cut}%: point at the state document instead of repeating it.`
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

/**
 * The instructions as a compaction gets them. Once the conversation has moved
 * on since they were written, the summary is told so.
 */
export function instructionsFor(proposal: Proposal, gauge: Gauge | null): string {
  const age = ageOf(proposal, gauge)

  return age < STALE_TOKENS
    ? proposal.instructions
    : `${proposal.instructions}\n\n(These instructions were written about ${tokensText(age)} tokens of conversation ago. Where the later conversation differs from them, the later conversation wins.)`
}

export function compactLine(instructions: string): string {
  return `/compact ${instructions}`
}

/** The most agents and tasks the tool's answer names one by one. */
export const MAX_NAMED = 10

/** The most background tasks the mod keeps track of; past it, the oldest goes. */
export const MAX_TASKS = 50

const LABEL_LENGTH = 60

/** True while the agent's loop is still at work, so its report is still to come. */
export function isUnfinished(status: AgentStatus): boolean {
  switch (status) {
    case 'pending':
    case 'running':
    case 'waiting':
      return true
    case 'idle':
    case 'completed':
    case 'failed':
    case 'killed':
      return false
    default:
      // A status newer than these types. Naming one agent too many costs a
      // line. Missing one leaves its report unexplained.
      status satisfies never

      return true
  }
}

/**
 * The agents that still owe the main conversation a report. An agent that
 * another agent spawned reports to that one.
 */
export function unfinishedOf(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter(agent => agent.parentId === undefined && isUnfinished(agent.status))
}

export type TaskKind = 'command' | 'workflow' | 'monitor'

/** A background task the main conversation started, as a tool's result named it. */
export type Task = {
  /** The task's id, as its notification names it. */
  id: string
  kind: TaskKind
  /** What it runs, in one short line; empty when the call did not say. */
  label: string
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined
}

/** The first line of a text, cut to the length of a label; empty for none. */
function labelOf(...candidates: unknown[]): string {
  const text = candidates.find(each => typeof each === 'string' && each.trim() !== '')
  const line = typeof text === 'string' ? (text.trim().split('\n')[0] ?? '') : ''

  return line.length > LABEL_LENGTH ? `${line.slice(0, LABEL_LENGTH - 1)}…` : line
}

/**
 * The background task a tool call started, read from the call and its result;
 * undefined when it started none that can report later.
 */
export function taskOf(call: unknown, result: unknown): Task | undefined {
  const command = field(result, 'backgroundTaskId')

  // A command of any shell tool, sent or moved to the background. One that is
  // ended at the final response sends no notification.
  if (typeof command === 'string') {
    return field(result, 'backgroundEndsWithFinalResponse') === true
      ? undefined
      : { id: command, kind: 'command', label: labelOf(field(call, 'description'), field(call, 'command')) }
  }

  const id = field(result, 'taskId')
  const tool = field(call, 'tool')

  if (typeof id !== 'string') {
    return undefined
  }

  if (tool === 'Workflow') {
    return { id, kind: 'workflow', label: labelOf(field(result, 'workflowName')) }
  }

  if (tool === 'Monitor') {
    return { id, kind: 'monitor', label: labelOf(field(call, 'description')) }
  }

  return undefined
}

/** The id of the task a TaskStop call stopped; undefined for any other call. */
export function stoppedOf(call: unknown, result: unknown): string | undefined {
  const id = field(result, 'task_id')

  return field(call, 'tool') === 'TaskStop' && typeof id === 'string' ? id : undefined
}

const NOTIFICATION_END = '</task-notification>'
const TASK_ID = /<task-id>([^<]+)<\/task-id>/
const TASK_STATUS = /<status>([^<]+)<\/status>/
/** The words a notification uses for a task that is over. */
const ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped'])

/**
 * The ids of the tasks that a task notification reports as over. A
 * notification without such a status (a monitor's event) ends nothing.
 */
export function endedIn(text: string): string[] {
  return text.split(NOTIFICATION_END).flatMap(part => {
    const id = TASK_ID.exec(part)?.[1]?.trim()
    const status = TASK_STATUS.exec(part)?.[1]?.trim()

    return id !== undefined && status !== undefined && ENDED.has(status) ? [id] : []
  })
}

function agentName(agent: AgentInfo): string {
  return `agent "${agent.description}" (${agent.type}, id ${agent.id})`
}

function taskName(task: Task): string {
  return task.label === ''
    ? `${task.kind} (id ${task.id})`
    : `${task.kind} "${task.label}" (id ${task.id})`
}

/**
 * What is still running beside the main conversation, each as the tool's
 * answer names it: the unfinished agents, then the tasks with no end seen.
 */
export function runningOf(agents: readonly AgentInfo[], tasks: readonly Task[]): string[] {
  return [...unfinishedOf(agents).map(agentName), ...tasks.map(taskName)]
}

/** What the tool's answer says about what is still running; empty for nothing. */
export function runningText(running: readonly string[]): string {
  if (running.length === 0) {
    return ''
  }

  const rest = running.length - MAX_NAMED
  const more = rest > 0 ? `; and ${rest} more` : ''

  return ` Still running, as far as the mod can tell: ${running.slice(0, MAX_NAMED).join('; ')}${more}. Each one may report after the compaction, to a conversation that no longer holds its task. If your instructions do not say what each one is doing and what to do with its report, call this tool again with instructions that do.`
}

/** The tool's answer: the proposal is stored, and what the model does next. */
export function storedText(
  gauge: Gauge | null,
  isUnattended: boolean,
  running: readonly string[],
): string {
  const at = gauge === null ? '' : ` ${where(gauge)}`
  const end = running.length === 0 ? 'End your turn now' : 'Then end your turn'
  const then = isUnattended
    ? `${end}. The mod compacts the conversation with these instructions when the turn ends, then sends you a prompt to continue.`
    : `${end}, with one or two lines for the user. The mod puts the /compact line with these instructions in the prompt box, and the user presses Enter. An automatic compaction uses them too.`

  return `Stored.${at}${runningText(running)} ${then}`
}

/** Why the mod refuses a summary that the engine wants to compute ahead of time. */
export const PRECOMPUTE_SKIP =
  'compact-warning: the summary is written when the compaction runs, so that it follows the instructions of that moment.'

export const RESUME_PROMPT =
  'The conversation was compacted with your own instructions. If you wrote the state down, read it first. Then continue the work.'

export type Status = {
  gauge: Gauge | null
  told: Told
  hasProposal: boolean
  /** Tokens the context has grown since the proposal was stored. */
  age: number
  lastError: string | undefined
}

/**
 * The line under the prompt, or undefined for none. The engine draws it as a
 * warning, with the mod's name in front. So it is there only when there is
 * something to act on: a nudge was given, a /compact line waits, or a hook of
 * the mod failed.
 */
export function statusText(status: Status): string | undefined {
  const { gauge, told, hasProposal, age, lastError } = status
  const ready = age < STALE_TOKENS ? '/compact ready' : `/compact ready, saved ${tokensText(age)} tokens ago`
  const state = hasProposal
    ? ready
    : told === 'stop'
      ? 'stopping at the next breakpoint'
      : told === 'warn'
        ? 'looking for a breakpoint'
        : undefined

  if (state === undefined && lastError === undefined) {
    return undefined
  }

  const error = lastError === undefined ? undefined : `error in ${lastError}`

  return [gauge === null ? undefined : fill(gauge), state, error]
    .filter(part => part !== undefined)
    .join(' · ')
}

function nudgesAt(thresholds: Thresholds): string {
  return thresholds.warn === thresholds.stop
    ? `at ${tokensText(thresholds.stop)} tokens`
    : `at ${tokensText(thresholds.warn)} and ${tokensText(thresholds.stop)} tokens`
}

/**
 * The line above the prompt when a session starts: what it says, its detail
 * in dim, and whether the mod is on.
 */
export type GreetingText = { text: string; detail: string; isOff: boolean }

/** The line above the prompt once the start check has passed. */
export function greetingText(
  limit: number,
  isAutoCompact: boolean,
  thresholds: Thresholds,
): GreetingText {
  const nudges = thresholds.warn === thresholds.stop ? 'one nudge' : 'nudges'
  const limitText = isAutoCompact ? `auto-compact at ${tokensText(limit)}` : 'auto-compact is off'

  return {
    text: '✓ compact-warning is working',
    detail: ` · ${nudges} ${nudgesAt(thresholds)} · ${limitText}`,
    isOff: false,
  }
}

/** The line above the prompt on a Claude Code older than the mod's floor. */
export function offGreeting(version: string): GreetingText {
  return { text: 'compact-warning is off', detail: ` · ${floorText(version)}`, isOff: true }
}

/** The row above the prompt while a /compact line waits: its first sentence. */
export function readyText(gauge: Gauge | null): string {
  if (gauge === null) {
    return 'Ready to compact.'
  }

  return isAuto(gauge)
    ? `Ready to compact at ${gauge.percent}% of auto-compact.`
    : `Ready to compact: the context window is ${gauge.percent}% full.`
}

/** The rest of that row, drawn dim: what to run, and the age of old instructions. */
export function readyHint(age: number): string {
  const old = age < STALE_TOKENS ? '' : ` They were saved ${tokensText(age)} tokens ago.`

  return ` Run /compact: the saved instructions apply.${old}`
}

/** Where a copy that Claude Code installed from a marketplace lives. */
export type Install = {
  /** Claude Code's configuration folder. */
  configDir: string
  /** The marketplace the copy came from, as Claude Code names it. */
  marketplace: string
}

// <config>/plugins/cache/<marketplace>/<plugin>/<version>, with either slash.
const INSTALLED = /^(.+)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/][^\\/]+[\\/][^\\/]+[\\/]?$/

/**
 * Reads where the mod was installed from its own folder. Undefined for a copy
 * that Claude Code reads in place: a local folder, or one named at the start.
 */
export function installOf(root: string): Install | undefined {
  const found = INSTALLED.exec(root)
  const [, configDir, marketplace] = found ?? []

  return configDir === undefined || marketplace === undefined ? undefined : { configDir, marketplace }
}

/**
 * True when Claude Code updates the marketplace's plugins by itself. `declared`
 * is the settings' `extraKnownMarketplaces`, and `known` is Claude Code's own
 * record of its marketplaces. An entry in the settings wins. With neither, a
 * marketplace like this one is updated by hand.
 */
export function isAutoUpdated(marketplace: string, declared: unknown, known: unknown): boolean {
  const inSettings = field(field(declared, marketplace), 'autoUpdate')

  return typeof inSettings === 'boolean'
    ? inSettings
    : field(field(known, marketplace), 'autoUpdate') === true
}

/** How updates reach an installed copy. */
export type Updates = { marketplace: string; isAutomatic: boolean }

/** How a person gets a newer version of the mod. */
export function updateCommand(marketplace: string = COMMAND): string {
  return `claude plugin update ${COMMAND}@${marketplace}`
}

/** What the one notice says to a person whose copy is updated by hand. */
export const UPDATES_NOTICE = `Fixes do not reach this mod by themselves. /${COMMAND} says how to change that.`

/** The store's key that says the notice about updates was given. */
export const UPDATES_TOLD_KEY = 'toldAboutUpdates'

/** True when the notice about updates is due: once, for a copy updated by hand. */
export function isNoticeDue(updates: Updates | undefined, told: unknown): boolean {
  return updates !== undefined && !updates.isAutomatic && told !== true
}

/** The report's line on updates, with the way to make them automatic. */
export function updatesText(updates: Updates): string {
  return updates.isAutomatic
    ? 'Updates: automatic'
    : `Updates: by hand. For fixes by themselves: /plugin, Marketplaces, ${updates.marketplace}, Turn on auto-update`
}

/** What the toast says when a hook of the mod has failed. */
export function errorToast(lastError: string): string {
  return `Error in ${lastError}. Run /${COMMAND} for what to do.`
}

/** The start of the report: the verdict of the checks, and what to do. */
export function healthText(lastError: string | undefined, marketplace?: string): string {
  return lastError === undefined
    ? 'Health: working'
    : `Health: needs attention, error in ${lastError}\nFor a fix, run: ${updateCommand(marketplace)}`
}

/** What /compact-warning prints on a Claude Code older than the mod's floor. */
export function offReport(version: string): string {
  return `Health: off, ${floorText(version)}\nUpdate Claude Code to turn the mod on. Its stable channel gets a version later than its latest channel.`
}

export type Report = {
  gauge: Gauge | null
  limit: number
  isAutoCompact: boolean
  told: Told
  proposal: Proposal | null
  settings: Settings
  engineVersion: string | undefined
  /** Undefined for a copy that Claude Code reads in place. */
  updates: Updates | undefined
  lastError: string | undefined
}

const TOLD_WORDS: Readonly<Record<Told, string>> = {
  none: 'none sent yet',
  warn: 'first sent',
  stop: 'second sent',
}

function contextLine(report: Report): string {
  const { gauge, limit, isAutoCompact } = report

  if (gauge === null) {
    const what = isAutoCompact ? 'auto-compact at' : 'auto-compact is off, window of'

    return `Context: no reading yet, ${what} ${tokensText(limit)} tokens`
  }

  return isAuto(gauge)
    ? `Context: ${sizes(gauge)}, ${gauge.percent}% of auto-compact`
    : `Context: ${sizes(gauge)}, ${gauge.percent}% of the window (auto-compact is off)`
}

function proposalLine(proposal: Proposal | null, gauge: Gauge | null): string {
  if (proposal === null) {
    return 'Proposal: none'
  }

  const age = ageOf(proposal, gauge)
  const old = age < STALE_TOKENS ? '' : `, saved ${tokensText(age)} tokens ago`
  const state = proposal.isHandedOver ? 'ready for /compact' : 'stored, offered when the turn ends'

  return `Proposal: ${state}${old}\n${proposal.instructions}`
}

/** What /compact-warning prints. */
export function reportText(report: Report): string {
  const { gauge, limit, told, proposal, settings, engineVersion, updates, lastError } = report

  return [
    healthText(lastError, updates?.marketplace),
    contextLine(report),
    `Nudges: ${nudgesAt(thresholdsOf(limit, settings))}, ${TOLD_WORDS[told]}`,
    `Settings: ${settingsText(settings)}`,
    `To change one: /${COMMAND} stop 300k`,
    `Claude Code: ${engineVersion ?? 'unknown version'}`,
    ...(updates === undefined ? [] : [updatesText(updates)]),
    proposalLine(proposal, gauge),
  ].join('\n')
}

export const TOOL_DESCRIPTION = `Proposes a compaction of this conversation at a good breakpoint. Call it only in the main conversation, after you have written the session's state where the project keeps it (a status document, a commit), if it has such a place. ${BREAKPOINT} After the call, end your turn: the user gets a ready /compact line with your instructions, and an automatic compaction uses them too.`

export const INSTRUCTIONS_DESCRIPTION = `Aim for ${AIM_INSTRUCTIONS} characters or fewer: point at documents, do not repeat them. Say what the summary must keep, most important first, then what to drop. A shape that works: (1) your role and the agreed plan, with what not to start; (2) where the truth is: the document and section to read first after the compaction, or the state itself when no document holds it; (3) the live state: what is running, by id, and what to do when each finishes; (4) the exact commands of any repeated step; (5) the nevers; (6) what is still owed; (7) the user's decisions that shape everything; (8) drop: content already written into documents, tool output, back-and-forth.`
