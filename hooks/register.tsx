// compact-warning: tells the model in time that the context is filling up,
// takes the compaction it proposes at a breakpoint, and hands the person a
// ready /compact line. An automatic compaction uses the same instructions.
//
// A subagent has nobody at a prompt, and no mod can start its compaction. So
// the mod sends it a message shortly before Claude Code compacts it, to ask
// for its instructions, and that compaction gets them.
//
// Every hook passes the event on unchanged when its own work fails: the
// session then falls back to plain auto-compaction, and the failure shows in
// the status line under the prompt.
//
// The engine draws the status line as a warning, so the mod shows one only
// from the first nudge on, or for a fault. At the start of a session a green
// line above the prompt says for a few seconds that the checks passed.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Gauge } from '../types'
import {
  COMMAND,
  INSTRUCTIONS_DESCRIPTION,
  MAX_SUBAGENT_ASKS,
  MAX_TASKS,
  MIN_VERSION,
  NO_PROJECT,
  PRECOMPUTE_SKIP,
  RESUME_PROMPT,
  SETTINGS_KEY,
  STALE_NOTE,
  SUBAGENTS_OFF,
  SUBAGENT_STORED,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  UPDATES_NOTICE,
  UPDATES_TOLD_KEY,
  USAGE,
  ageOf,
  asksSubagents,
  changedText,
  cleanInstructions,
  compactLine,
  endedIn,
  errorToast,
  folderKey,
  foldersFor,
  gaugeOf,
  greetingText,
  hasShrunk,
  installOf,
  instructionsFor,
  isAutoUpdated,
  isNoticeDue,
  isOlder,
  isStronger,
  levelOf,
  nudgeText,
  offGreeting,
  offReport,
  projectOf,
  readyHint,
  readyText,
  refusalOf,
  reportText,
  requestOf,
  runningOf,
  settingsOf,
  statusText,
  stoppedOf,
  storedOf,
  storedText,
  subagentLimitOf,
  subagentNudgeText,
  subagentThresholdOf,
  taskOf,
  thresholdsOf,
  toastText,
} from './logic'
import type { GreetingText, Layer, Settings, StoredSettings, Task, Updates } from './logic'

type Engine = EngineInterface

/**
 * What Claude Code lists for an agent from 2.1.326 on: the size of its context
 * and its model's window. An older one leaves both out, and its types too.
 */
type Sized = { tokenCount?: number; contextWindowSize?: number }

// The mod's own tool, matched by pattern: the typed tool names are only
// the ones that were connected when the engine last wrote the types.
const OWN_TOOL = /^mcp__compact-warning__propose_compact$/

const told = atom({ plugin: 'compact-warning', key: 'told' } as const, 'none')
const proposal = atom({ plugin: 'compact-warning', key: 'proposal' } as const, null)
const gauge = atom({ plugin: 'compact-warning', key: 'gauge' } as const, null)
const isRowHidden = atom({ plugin: 'compact-warning', key: 'isRowHidden' } as const, false)
const greeting = atom({ plugin: 'compact-warning', key: 'greeting' } as const, null)
const subagents = atom({ plugin: 'compact-warning', key: 'subagents' } as const, {})

/** How long the auto-compaction point is trusted before it is read again. */
const LIMIT_TTL_MS = 5 * 60 * 1000
/** After this long, a reading that never finished no longer holds others back. */
const SENSE_STALE_MS = 30 * 1000
/**
 * How long the settings are trusted before the store and the project are read
 * again: a change made in one session reaches the others within this time.
 */
const SETTINGS_TTL_MS = 10 * 1000
/** The wait between the end of a turn and an unattended compaction. */
const UNATTENDED_DELAY_MS = 500
const LONG_TOAST_MS = 10 * 1000
/** How long the line of the start check stays above the prompt. */
const GREETING_MS = 10 * 1000
const ERROR_LENGTH = 160
const COMMAND_DESCRIPTION = 'Show how close this session is to auto-compaction, or change a setting'

/** What the context is measured against. */
type Limit = {
  /** Where auto-compaction fires, or the whole window while it is off. */
  limit: number
  isAutoCompact: boolean
  /** The window that compaction counts against: the model's, or a smaller one that was set. */
  compactWindow: number
}

/** The settings in force, and the project and the folders they were read for. */
type SettingsHere = {
  settings: Settings
  /** Undefined when the session's root cannot be read. */
  project: string | undefined
  layers: Layer[]
}

let limitCache: (Limit & { window: number; at: number }) | undefined
let settingsCache: (SettingsHere & { at: number }) | undefined
let senseStartedAt: number | undefined
/** The subagents whose fill is being read: of several calls at once, one reads. */
const sensing = new Set<string>()
let engineVersion: string | undefined
/**
 * True on a Claude Code older than the mod's floor. The mod is then off: its
 * hooks pass every event on, and the start line and the report say why.
 */
let isOff = false
let lastError: string | undefined

/**
 * The background commands, workflows and monitors that the main conversation
 * started, and whose end the mod has not seen. The engine has no list of them
 * to read, so the mod keeps its own. They live as long as this process, and so
 * does the list: a compaction and a /clear leave both as they are.
 */
const tasks = new Map<string, Task>()

/** Notes the background task a tool call started, and forgets one it stopped. */
function track(call: unknown, result: unknown): void {
  const started = taskOf(call, result)

  if (started !== undefined) {
    tasks.delete(started.id)
    tasks.set(started.id, started)

    for (const oldest of tasks.keys()) {
      if (tasks.size <= MAX_TASKS) {
        break
      }

      tasks.delete(oldest)
    }
  }

  const stopped = stoppedOf(call, result)

  if (stopped !== undefined) {
    tasks.delete(stopped)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the mod's own work for a hook. A failure never reaches the engine: it
 * goes to the status line and one toast, and the hook carries on without it.
 */
async function guarded<T>(
  $: Engine,
  where: string,
  job: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    return await job()
  } catch (error) {
    // An abandoned dispatch (the person interrupted) is no fault of the mod.
    if (signal?.aborted === true) {
      return undefined
    }

    const line = `${where}: ${messageOf(error)}`.slice(0, ERROR_LENGTH)

    if (line !== lastError) {
      lastError = line
      $.ui.toast(errorToast(line), { timeoutMs: LONG_TOAST_MS })
    }

    $.ui.status(`error in ${line}`)

    return undefined
  }
}

/** A value from the store; undefined when it cannot be read. */
async function storedAt($: Engine, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

/** The session's project; undefined when its root cannot be read. */
async function projectNow($: Engine): Promise<string | undefined> {
  try {
    return projectOf(await $.session.root())
  } catch {
    return undefined
  }
}

/**
 * The settings of the folders that hold in the project, outermost first. A
 * folder whose settings cannot be read, or hold nothing valid, is left out.
 */
async function layersOf($: Engine, project: string): Promise<Layer[]> {
  let keys: string[]

  try {
    keys = await $.store.keys()
  } catch {
    return []
  }

  const layers = await Promise.all(
    foldersFor(keys, project).map(async folder => ({
      folder,
      stored: storedOf(await storedAt($, folderKey(folder))),
    })),
  )

  return layers.filter(layer => Object.keys(layer.stored).length > 0)
}

/**
 * The settings in force, read at most every few seconds, with the project and
 * the folders they come from. What cannot be read holds no nudge back: it
 * counts as not set.
 */
async function settingsHere($: Engine): Promise<SettingsHere> {
  const now = Date.now()

  if (settingsCache !== undefined && now - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache
  }

  const project = await projectNow($)
  const layers = project === undefined ? [] : await layersOf($, project)
  const settings = settingsOf(await storedAt($, SETTINGS_KEY), layers)
  settingsCache = { settings, project, layers, at: now }

  return settingsCache
}

/** The settings in force in this session. */
async function settingsNow($: Engine): Promise<Settings> {
  return (await settingsHere($)).settings
}

/** Saves a change to the settings under `key`, or with no change removes them. */
async function saveSettings($: Engine, key: string, change: StoredSettings | undefined): Promise<void> {
  if (change === undefined) {
    await $.store.delete(key)
  } else {
    await $.store.set(key, { ...storedOf(await $.store.get(key)), ...change })
  }

  settingsCache = undefined
}

/** What the context is measured against, read at most every few minutes. */
async function limitOf($: Engine, window: number): Promise<Limit> {
  const now = Date.now()

  if (
    limitCache !== undefined &&
    limitCache.window === window &&
    now - limitCache.at < LIMIT_TTL_MS
  ) {
    return limitCache
  }

  const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
  const point = breakdown?.autoCompactThreshold
  const found = point ?? breakdown?.rawMaxTokens ?? window
  // The breakdown leaves the point out while auto-compaction is off.
  const isAutoCompact = breakdown === undefined || point !== undefined
  const compactWindow = breakdown?.rawMaxTokens ?? window
  limitCache = {
    window,
    limit: found > 0 ? found : window,
    isAutoCompact,
    compactWindow: compactWindow > 0 ? compactWindow : window,
    at: now,
  }

  return limitCache
}

/** Reads the context's fill; null until the live window has had a response. */
async function measure($: Engine): Promise<Gauge | null> {
  const { context } = await $.session.usage()

  if (context.tokens === undefined) {
    return null
  }

  const { limit, isAutoCompact } = await limitOf($, context.window)

  return gaugeOf(context.tokens, limit, isAutoCompact)
}

/** Stores the reading for the row above the prompt and redraws the status line. */
async function show($: Engine, reading: Gauge | null): Promise<void> {
  const shown = await read($, gauge)

  if (
    shown?.percent !== reading?.percent ||
    shown?.limit !== reading?.limit ||
    shown?.isAutoCompact !== reading?.isAutoCompact
  ) {
    await update($, gauge, () => reading)
  }

  const stored = await read($, proposal)

  $.ui.status(
    statusText({
      gauge: reading,
      told: await read($, told),
      hasProposal: stored !== null,
      age: ageOf(stored, reading),
      lastError,
    }),
  )
}

async function refresh($: Engine): Promise<void> {
  await show($, await measure($))
}

/**
 * The deep reading for a health check: unlike `measure`, it reads the limit
 * afresh, and also before the first response.
 */
async function inspect($: Engine): Promise<Limit & { reading: Gauge | null }> {
  limitCache = undefined
  const { context } = await $.session.usage()
  const { limit, isAutoCompact, compactWindow } = await limitOf($, context.window)

  return {
    reading:
      context.tokens === undefined ? null : gaugeOf(context.tokens, limit, isAutoCompact),
    limit,
    isAutoCompact,
    compactWindow,
  }
}

/** Takes the green line away: all of them, or only the one that ends at `until`. */
async function endGreeting($: Engine, until?: number): Promise<void> {
  const held = await read($, greeting)

  if (held !== null && (until === undefined || held.until === until)) {
    await update($, greeting, () => null)
  }
}

/** Shows the green line that says the start check passed, for a few seconds. */
async function greet($: Engine, line: GreetingText): Promise<void> {
  const until = Date.now() + GREETING_MS
  await update($, greeting, () => ({ ...line, until }))
  $.clock.after(GREETING_MS, () => {
    void guarded($, 'the start check', () => endGreeting($, until))
  })
}

/**
 * Reads the fill and answers the note for the model when it has reached a
 * nudge the model has not had yet. Of several calls at once, one reads.
 */
async function sense($: Engine): Promise<string | undefined> {
  const now = Date.now()

  if (senseStartedAt !== undefined && now - senseStartedAt < SENSE_STALE_MS) {
    return undefined
  }

  senseStartedAt = now

  try {
    const reading = await measure($)

    if (reading === null) {
      await show($, null)

      return undefined
    }

    let stored = await read($, proposal)

    // Far fewer tokens than when it was proposed: the context was compacted,
    // cleared or rewound, and the proposal describes a state that is gone.
    if (stored !== null && stored.tokens !== null && reading.tokens < stored.tokens / 2) {
      stored = await update($, proposal, () => null)
    }

    const before = await read($, told)
    const thresholds = thresholdsOf(reading.limit, await settingsNow($))
    const level = levelOf(reading.tokens, thresholds)
    let note: string | undefined

    if (level !== 'none' && isStronger(level, before)) {
      await update($, told, () => level)
      note = nudgeText(level, reading, stored !== null)
      $.ui.toast(toastText(level, reading), { timeoutMs: LONG_TOAST_MS })
    } else if (before !== 'none' && hasShrunk(reading, thresholds)) {
      await update($, told, () => 'none')
    }

    await show($, reading)

    return note
  } finally {
    senseStartedAt = undefined
  }
}

/**
 * Reads a subagent's fill against the point where Claude Code compacts it.
 * Undefined before its first response, and while auto-compaction is off: then
 * no compaction comes that instructions could steer.
 */
async function measureSubagent($: Engine, id: string): Promise<Gauge | undefined> {
  const { context } = await $.session.usage()
  const main = await limitOf($, context.window)

  if (!main.isAutoCompact) {
    return undefined
  }

  const agent: (AgentInfo & Sized) | undefined = (await $.agent.list()).find(each => each.id === id)
  const tokens = agent?.tokenCount

  // No reading yet. A count that is missing is no reading either.
  if (agent === undefined || tokens === undefined || !(tokens > 0)) {
    return undefined
  }

  const limit = subagentLimitOf(
    { window: context.window, compactWindow: main.compactWindow, point: main.limit },
    agent.contextWindowSize,
  )

  return gaugeOf(tokens, limit)
}

/**
 * Sends a subagent a message, as the SendMessage tool would. False when it
 * could not be delivered.
 */
async function tell($: Engine, id: string, text: string): Promise<boolean> {
  try {
    return (await $.session.send({ to: { agentId: id }, text })).isDelivered
  } catch {
    return false
  }
}

/**
 * Asks a subagent whose context has come close to its compaction for its
 * instructions, when it has stored none yet. The request goes as a message.
 * Only when that cannot be delivered is it answered here, to travel with the
 * tool's result: there a subagent often takes it for an injected instruction.
 * A subagent that reads on gets one reminder.
 */
async function senseSubagent($: Engine, id: string): Promise<string | undefined> {
  if (sensing.has(id) || !asksSubagents(await settingsNow($), engineVersion)) {
    return undefined
  }

  sensing.add(id)

  try {
    const held = (await read($, subagents))[id]
    const asked = (held?.asked ?? 0) + 1

    // It has answered, or it was asked often enough.
    if ((held !== undefined && held.proposal !== null) || asked > MAX_SUBAGENT_ASKS) {
      return undefined
    }

    const reading = await measureSubagent($, id)

    if (reading === undefined || reading.tokens < subagentThresholdOf(reading.limit)) {
      return undefined
    }

    await update($, subagents, all => ({ ...all, [id]: { proposal: null, asked } }))
    const request = subagentNudgeText(reading, asked)

    return (await tell($, id, request)) ? undefined : request
  } finally {
    sensing.delete(id)
  }
}

/** Stores the compaction a subagent proposed, for the compaction that comes. */
async function storeForSubagent($: Engine, id: string, instructions: string): Promise<void> {
  // A reading that fails holds no proposal back: its age is then unknown.
  const reading = await measureSubagent($, id).catch(() => undefined)
  const tokens = reading?.tokens ?? null
  await update($, subagents, all => ({
    ...all,
    [id]: { proposal: { instructions, tokens }, asked: all[id]?.asked ?? 0 },
  }))
}

/** Forgets a subagent: it was compacted, or its run has ended. */
async function forgetSubagent($: Engine, id: string): Promise<void> {
  if ((await read($, subagents))[id] !== undefined) {
    await update($, subagents, all =>
      Object.fromEntries(Object.entries(all).filter(([each]) => each !== id)),
    )
  }
}

async function notesAtPrompt($: Engine): Promise<string[]> {
  // The person is at the prompt and has seen the line of the start check.
  await endGreeting($)
  const note = await sense($)
  const stored = await read($, proposal)
  const notes = note === undefined ? [] : [note]

  if (stored !== null && stored.isHandedOver) {
    notes.push(STALE_NOTE)
  }

  return notes
}

/** Forgets the nudges and the proposal: the context starts over. */
async function reset($: Engine): Promise<void> {
  await update($, told, () => 'none')
  await update($, proposal, () => null)
  await update($, isRowHidden, () => false)
  await show($, null)
}

/** Compacts with the stored instructions, then tells the session to go on. */
async function compactUnattended($: Engine): Promise<void> {
  const stored = await read($, proposal)

  if (stored === null) {
    return
  }

  let outcome

  try {
    outcome = await $.session.compact({ instructions: stored.instructions })
  } catch {
    // A new turn is running. The proposal stays, and its end tries again.
    return
  }

  if (outcome.skip !== undefined) {
    $.ui.toast(`The compaction was skipped: ${outcome.skip}`, { timeoutMs: LONG_TOAST_MS })

    return
  }

  await reset($)
  await $.prompt.submit({ text: RESUME_PROMPT })
}

/** At the end of a main-conversation turn: offer the proposal, once. */
async function handOver($: Engine, hasAnswered: boolean): Promise<void> {
  await refresh($)
  const stored = await read($, proposal)

  if (stored === null || stored.isHandedOver) {
    return
  }

  if ((await settingsNow($)).isUnattended && hasAnswered) {
    $.clock.after(UNATTENDED_DELAY_MS, () => {
      void guarded($, 'the unattended compaction', () => compactUnattended($))
    })

    return
  }

  // A draft the person is typing stays: /compact alone uses the instructions.
  const box = await $.prompt.read()
  const isFilled =
    box.text.trim() === '' &&
    (await $.prompt.fill({ text: compactLine(stored.instructions) })).isFilled

  await update($, proposal, held => (held === null ? held : { ...held, isHandedOver: true }))
  await update($, isRowHidden, () => false)
  $.ui.toast(
    isFilled
      ? 'Ready to compact. Press Enter to run the /compact line.'
      : 'Ready to compact. Type /compact and press Enter: the saved instructions are used.',
    { timeoutMs: LONG_TOAST_MS },
  )
}

/**
 * Reads the running Claude Code's version and settles whether the mod is on.
 * A Claude Code from 2.1.323 on reads the manifest's `engines` and never loads
 * a mod it is too old for. An older one loads it, so the mod checks by itself.
 */
async function checkFloor($: Engine): Promise<void> {
  const { version } = await $.session.version()
  engineVersion = version
  isOff = isOlder(version, MIN_VERSION)
}

/**
 * How updates reach this copy; undefined for a copy that Claude Code reads in
 * place. The setting has two homes, and either read may fail: what cannot be
 * read counts as not set.
 */
async function updatesNow($: Engine): Promise<Updates | undefined> {
  const install = installOf($.plugin.root)

  if (install === undefined) {
    return undefined
  }

  let declared: unknown
  let known: unknown

  try {
    declared = await $.settings.read({ key: 'extraKnownMarketplaces' })
  } catch {
    declared = undefined
  }

  try {
    known = JSON.parse(await $.fs.read(`${install.configDir}/plugins/known_marketplaces.json`))
  } catch {
    known = undefined
  }

  const { marketplace } = install

  return { marketplace, isAutomatic: isAutoUpdated(marketplace, declared, known) }
}

/**
 * Tells a person once that their copy gets no fixes by itself. A fix for a
 * break that a new Claude Code causes would otherwise never reach them.
 */
async function tellAboutUpdates($: Engine): Promise<void> {
  if (isNoticeDue(await updatesNow($), await $.store.get(UPDATES_TOLD_KEY))) {
    await $.store.set(UPDATES_TOLD_KEY, true)
    $.ui.toast(UPDATES_NOTICE, { timeoutMs: LONG_TOAST_MS })
  }
}

/** The report, after the same readings as at the start. */
async function report($: Engine): Promise<string> {
  const { reading, limit, isAutoCompact } = await inspect($)
  await show($, reading)
  const { settings, project, layers } = await settingsHere($)

  return reportText({
    gauge: reading,
    limit,
    isAutoCompact,
    told: await read($, told),
    proposal: await read($, proposal),
    settings,
    project,
    layers,
    engineVersion,
    updates: await updatesNow($),
    lastError,
  })
}

export const register: Register = on => {
  // The start of a new or resumed session, and a reload of the mod. This is
  // also the health check: each step below is a part the mod relies on, and
  // the green line shows only when every one answered.
  on('session.start', async ($, e, next) => {
    await guarded($, 'session.start', async () => {
      await update($, greeting, () => null)
      // First of all: on a Claude Code that is too old, nothing below is sure
      // to work, and the mod must not half-run.
      await checkFloor($)

      if (isOff) {
        $.ui.status(undefined)
        // The command says why the mod is off. The start line does not depend
        // on it: an old Claude Code may refuse the way it is declared.
        await $.command.register({ name: COMMAND, description: COMMAND_DESCRIPTION }).catch(() => undefined)

        if (e.isInteractive && engineVersion !== undefined) {
          await greet($, offGreeting(engineVersion))
        }

        return
      }

      await $.command.register({
        name: COMMAND,
        description: COMMAND_DESCRIPTION,
        argumentHint: '[project] [setting value]',
      })
      await $.tool.register({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            instructions: { type: 'string', description: INSTRUCTIONS_DESCRIPTION },
          },
          required: ['instructions'],
        },
      })
      const { reading, limit, isAutoCompact } = await inspect($)
      await show($, reading)

      if (e.isInteractive && lastError === undefined) {
        const thresholds = thresholdsOf(limit, await settingsNow($))
        await greet($, greetingText(limit, isAutoCompact, thresholds))
        await tellAboutUpdates($)
      }
    })

    return next(e)
  })

  // Sense after every tool call. The main conversation gets its nudge with
  // the tool's result. A subagent gets the request for its instructions as a
  // message. A subagent's background task is left out of the list: it reports
  // to the subagent.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (isOff || OWN_TOOL.test(e.tool) || ran.deny !== undefined) {
      return ran
    }

    const { agentId } = e

    if (agentId === undefined) {
      track(e, ran.result)
    }

    const note = await guarded(
      $,
      'tool.call',
      () => (agentId === undefined ? sense($) : senseSubagent($, agentId)),
      next.signal,
    )

    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  // The tool the model calls: the main conversation at its breakpoint, a
  // subagent when it is asked.
  on('tool.call', { tool: OWN_TOOL }, async ($, e) => {
    const { agentId } = e

    if (agentId !== undefined && !asksSubagents(await settingsNow($), engineVersion)) {
      return { deny: SUBAGENTS_OFF }
    }

    const input = e as unknown as { instructions?: unknown }
    const instructions = cleanInstructions(input.instructions)
    const refusal = refusalOf(instructions)

    if (refusal !== undefined) {
      return { deny: refusal }
    }

    if (agentId !== undefined) {
      try {
        await storeForSubagent($, agentId, instructions)

        return { result: SUBAGENT_STORED }
      } catch (error) {
        return { deny: `compact-warning could not store the proposal: ${messageOf(error)}` }
      }
    }

    try {
      const reading = await measure($)
      await update($, proposal, () => ({
        instructions,
        tokens: reading?.tokens ?? null,
        isHandedOver: false,
      }))
      await update($, isRowHidden, () => false)
      // What is still running and may report later: the model is told, so
      // that its instructions can cover it. A list that fails holds nothing back.
      const agents = await guarded($, 'the agent list', () => $.agent.list())
      const running = runningOf(agents ?? [], [...tasks.values()])
      await show($, reading)

      return { result: storedText(reading, (await settingsNow($)).isUnattended, running) }
    } catch (error) {
      return { deny: `compact-warning could not store the proposal: ${messageOf(error)}` }
    }
  })

  // The tool only stores text, so it runs without a permission prompt: an
  // unattended session must not wait on one.
  on('tool.check', { tool: OWN_TOOL }, () => ({
    decision: 'allow',
    reason: 'It only stores the compaction instructions for the compact-warning mod.',
  }))

  on('prompt.submit', async ($, e, next) => {
    // A background task that reports its end is no longer running.
    if (e.origin.kind === 'task-notification') {
      for (const id of endedIn(e.text)) {
        tasks.delete(id)
      }
    }

    if (isOff || e.command !== undefined || e.isMeta === true) {
      return next(e)
    }

    const notes = await guarded($, 'prompt.submit', () => notesAtPrompt($), next.signal)

    return notes === undefined || notes.length === 0
      ? next(e)
      : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    const { agentId } = e

    if (!isOff) {
      // A subagent's run is over with its turn: what the mod held for it goes.
      await guarded(
        $,
        'turn.complete',
        () => (agentId === undefined ? handOver($, e.reason === 'answer') : forgetSubagent($, agentId)),
        next.signal,
      )
    }

    return done
  })

  // Every compaction, of the main conversation or of a subagent: when it
  // comes without instructions, pass on the stored ones. Never skip a real
  // one: a full window is worse.
  on('session.compact', async ($, e, next) => {
    const { agentId } = e

    if (isOff || (agentId !== undefined && !asksSubagents(await settingsNow($), engineVersion))) {
      return next(e)
    }

    // A summary computed ahead of time cannot follow instructions that are
    // written or changed later, and the engine may reuse it. So none is kept:
    // each compaction writes its summary when it runs. This skips no
    // compaction: ahead of time, nothing is installed.
    if (e.trigger === 'precompute') {
      return { skip: PRECOMPUTE_SKIP }
    }

    // The stored instructions apply when none were typed, and when the typed
    // ones are the line the mod filled in. Once the conversation has moved on
    // since they were written, the summary is told so.
    const instructions = await guarded($, 'session.compact', async () => {
      const typed = (e.instructions ?? '').trim()

      if (agentId !== undefined) {
        const held = (await read($, subagents))[agentId]?.proposal ?? null

        if (held === null || typed !== '') {
          return undefined
        }

        // A reading that fails holds no instructions back: their age is then unknown.
        const reading = await measureSubagent($, agentId).catch(() => undefined)

        return instructionsFor(held, reading ?? null)
      }

      const stored = await read($, proposal)

      if (stored === null || (typed !== '' && typed !== stored.instructions)) {
        return undefined
      }

      return instructionsFor(stored, await measure($))
    })
    const outcome = await next(instructions === undefined ? e : { ...e, instructions })

    if (outcome.skip === undefined) {
      await guarded($, 'session.compact', () =>
        agentId === undefined ? reset($) : forgetSubagent($, agentId),
      )
    }

    return outcome
  })

  on('session.end', async ($, e, next) => {
    if (!isOff && e.reason === 'clear') {
      await guarded($, 'session.end', () => reset($))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (!isOff && e.changed.includes('context')) {
      await guarded($, 'session.measure', () => refresh($), next.signal)
    }

    return next(e)
  })

  // The report, which is also the health check on demand, or a change to a
  // setting. A change is saved for every session on this machine, or for the
  // project's folder, and answers with the report.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const text = await guarded($, 'the command', async () => {
      // After a /cd the session is in another project: read its settings afresh.
      settingsCache = undefined
      await checkFloor($)

      if (isOff) {
        return offReport(engineVersion ?? '')
      }

      const request = requestOf(e.args)

      if (request.kind === 'refuse') {
        return `${request.why}\n\n${USAGE}`
      }

      if (request.kind === 'report') {
        return report($)
      }

      const { project, layers } = await settingsHere($)
      const key =
        request.scope === 'machine'
          ? SETTINGS_KEY
          : project === undefined
            ? undefined
            : folderKey(project)

      if (key === undefined) {
        return `${NO_PROJECT}\n\n${USAGE}`
      }

      await saveSettings($, key, request.kind === 'set' ? request.change : undefined)

      return `${changedText(request, project, layers)}\n\n${await report($)}`
    })

    return { text: text ?? `Health: needs attention, error in ${lastError ?? 'the command'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const stored = await read($, proposal)
    const isOffered = stored !== null && stored.isHandedOver && !(await read($, isRowHidden))

    // No proposal waits: the row is free for the line of the start check.
    if (!isOffered) {
      const hello = await read($, greeting)

      if (hello === null || Date.now() >= hello.until) {
        return next(e)
      }

      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box>
          <Text>
            <Text color={hello.isOff === true ? 'warning' : 'success'}>{hello.text}</Text>
            <Text dimColor>{hello.detail ?? ''}</Text>
          </Text>
        </Box>
      )
    }

    const reading = await read($, gauge)
    const { Box, Button, Text } = $.ui.resolve(e)

    // On a narrow surface the buttons wrap under the text as a group.
    return (
      <Box flexWrap="wrap" columnGap="md">
        <Text>
          {readyText(reading)}
          <Text dimColor>{readyHint(ageOf(stored, reading))}</Text>
        </Text>
        <Box columnGap="sm">
          <Button
            key="fill"
            label="Fill prompt"
            onPress={async () => {
              const held = await read($, proposal)

              if (held !== null) {
                await $.prompt.fill({ text: compactLine(held.instructions) })
              }
            }}
          />
          <Button
            key="hide"
            label="Hide"
            role="dismiss"
            onPress={() => update($, isRowHidden, () => true)}
          />
        </Box>
      </Box>
    )
  })
}
