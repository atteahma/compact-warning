// compact-warning: tells the model in time that the context is filling up,
// takes the compaction it proposes at a breakpoint, and hands the person a
// ready /compact line. An automatic compaction uses the same instructions.
//
// Every hook passes the event on unchanged when its own work fails: the
// session then falls back to plain auto-compaction, and the failure shows in
// the status line under the prompt.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Gauge } from '../types'
import {
  COMMAND,
  INSTRUCTIONS_DESCRIPTION,
  RESUME_PROMPT,
  STALE_NOTE,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  cleanInstructions,
  compactLine,
  configOf,
  gaugeOf,
  hasShrunk,
  isStronger,
  levelOf,
  nudgeText,
  refusalOf,
  reportText,
  statusText,
  storedText,
  toastText,
} from './logic'
import type { Config } from './logic'

type Engine = EngineInterface

// The mod's own tool, matched by pattern: the typed tool names are only
// the ones that were connected when the engine last wrote the types.
const OWN_TOOL = /^mcp__compact-warning__propose_compact$/

const told = atom({ plugin: 'compact-warning', key: 'told' } as const, 'none')
const proposal = atom({ plugin: 'compact-warning', key: 'proposal' } as const, null)
const gauge = atom({ plugin: 'compact-warning', key: 'gauge' } as const, null)
const isRowHidden = atom({ plugin: 'compact-warning', key: 'isRowHidden' } as const, false)

/** The file tools/check writes: the Claude Code version the tests passed on. */
const TESTED_VERSION_FILE = 'tested-version.txt'
const WARNED_VERSION_KEY = 'warnedVersion'

/** How long the auto-compaction point is trusted before it is read again. */
const LIMIT_TTL_MS = 5 * 60 * 1000
/** After this long, a reading that never finished no longer holds others back. */
const SENSE_STALE_MS = 30 * 1000
/** The wait between the end of a turn and an unattended compaction. */
const UNATTENDED_DELAY_MS = 500
const LONG_TOAST_MS = 10 * 1000
const ERROR_LENGTH = 160

let limitCache: { window: number; limit: number; at: number } | undefined
let senseStartedAt: number | undefined
let engineVersion: string | undefined
let versionNote: string | undefined
let lastError: string | undefined

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
      $.ui.toast(`compact-warning failed in ${line}`, { timeoutMs: LONG_TOAST_MS })
    }

    $.ui.status(`compact-warning: error in ${line}`)

    return undefined
  }
}

/** The token count where auto-compaction fires, read at most every few minutes. */
async function limitOf($: Engine, window: number): Promise<number> {
  const now = Date.now()

  if (
    limitCache !== undefined &&
    limitCache.window === window &&
    now - limitCache.at < LIMIT_TTL_MS
  ) {
    return limitCache.limit
  }

  const { context } = await $.session.usage({ breakdown: 'summary' })
  const found =
    context.breakdown?.autoCompactThreshold ?? context.breakdown?.rawMaxTokens ?? window
  const limit = found > 0 ? found : window
  limitCache = { window, limit, at: now }

  return limit
}

/** Reads the context's fill; null until the live window has had a response. */
async function measure($: Engine): Promise<Gauge | null> {
  const { context } = await $.session.usage()

  if (context.tokens === undefined) {
    return null
  }

  return gaugeOf(context.tokens, await limitOf($, context.window))
}

/** Stores the reading for the row above the prompt and redraws the status line. */
async function show($: Engine, reading: Gauge | null): Promise<void> {
  const shown = await read($, gauge)

  if (shown?.percent !== reading?.percent || shown?.limit !== reading?.limit) {
    await update($, gauge, () => reading)
  }

  $.ui.status(
    statusText({
      gauge: reading,
      told: await read($, told),
      hasProposal: (await read($, proposal)) !== null,
      versionNote,
      lastError,
    }),
  )
}

async function refresh($: Engine): Promise<void> {
  await show($, await measure($))
}

/**
 * Reads the fill and answers the note for the model when it has crossed a
 * threshold it was not told about yet. Of several calls at once, one reads.
 */
async function sense($: Engine, config: Config): Promise<string | undefined> {
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
    const level = levelOf(reading.percent, config)
    let note: string | undefined

    if (level !== 'none' && isStronger(level, before)) {
      await update($, told, () => level)
      note = nudgeText(level, reading, stored !== null)
      $.ui.toast(toastText(level, reading), { timeoutMs: LONG_TOAST_MS })
    } else if (before !== 'none' && hasShrunk(reading.percent, config)) {
      await update($, told, () => 'none')
    }

    await show($, reading)

    return note
  } finally {
    senseStartedAt = undefined
  }
}

async function notesAtPrompt($: Engine, config: Config): Promise<string[]> {
  const note = await sense($, config)
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
async function handOver($: Engine, config: Config, hasAnswered: boolean): Promise<void> {
  await refresh($)
  const stored = await read($, proposal)

  if (stored === null || stored.isHandedOver) {
    return
  }

  if (config.isUnattended && hasAnswered) {
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

/** Compares the running Claude Code with the version the tests passed on. */
async function checkVersion($: Engine): Promise<void> {
  const { version } = await $.session.version()
  engineVersion = version
  let tested: string | undefined

  try {
    tested = (await $.fs.read(`${$.plugin.root}/${TESTED_VERSION_FILE}`)).trim()
  } catch {
    tested = undefined
  }

  if (tested === version) {
    versionNote = undefined

    return
  }

  versionNote = `untested on Claude Code ${version}`

  if ((await $.store.get(WARNED_VERSION_KEY)) !== version) {
    await $.store.set(WARNED_VERSION_KEY, version)
    $.ui.toast(
      `compact-warning has not passed its tests on Claude Code ${version}. Run tools/check in its folder.`,
      { timeoutMs: LONG_TOAST_MS },
    )
  }
}

export const register: Register = (on, options) => {
  const config = configOf(options)

  on('session.start', async ($, e, next) => {
    await guarded($, 'session.start', async () => {
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
      await $.command.register({
        name: COMMAND,
        description: 'Show how close this session is to auto-compaction',
      })
      await checkVersion($)
      await refresh($)
    })

    return next(e)
  })

  // Sense after every tool call of the main conversation, and hand the model
  // the nudge with the tool's result.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.agentId !== undefined || OWN_TOOL.test(e.tool) || ran.deny !== undefined) {
      return ran
    }

    const note = await guarded($, 'tool.call', () => sense($, config), next.signal)

    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  // The tool the model calls at its breakpoint.
  on('tool.call', { tool: OWN_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main conversation can propose a compaction. A subagent cannot.' }
    }

    const input = e as unknown as { instructions?: unknown }
    const instructions = cleanInstructions(input.instructions)
    const refusal = refusalOf(instructions)

    if (refusal !== undefined) {
      return { deny: refusal }
    }

    try {
      const reading = await measure($)
      await update($, proposal, () => ({
        instructions,
        tokens: reading?.tokens ?? null,
        isHandedOver: false,
      }))
      await update($, isRowHidden, () => false)
      await show($, reading)

      return { result: storedText(reading, config.isUnattended) }
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
    if (e.command !== undefined || e.isMeta === true) {
      return next(e)
    }

    const notes = await guarded(
      $,
      'prompt.submit',
      () => notesAtPrompt($, config),
      next.signal,
    )

    return notes === undefined || notes.length === 0
      ? next(e)
      : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      await guarded(
        $,
        'turn.complete',
        () => handOver($, config, e.reason === 'answer'),
        next.signal,
      )
    }

    return done
  })

  // Every compaction of the main conversation: when none were typed, pass on
  // the stored instructions. Never skip one: a full window is worse.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const stored = await guarded($, 'session.compact', () => read($, proposal))
    const hasTyped = (e.instructions ?? '').trim() !== ''
    const outcome = await next(
      stored === undefined || stored === null || hasTyped
        ? e
        : { ...e, instructions: stored.instructions },
    )

    if (outcome.skip === undefined && e.trigger !== 'precompute') {
      await guarded($, 'session.compact', () => reset($))
    }

    return outcome
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await guarded($, 'session.end', () => reset($))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await guarded($, 'session.measure', () => refresh($), next.signal)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const text = await guarded($, 'the status command', async () => {
      const reading = await measure($)
      await show($, reading)

      return reportText({
        gauge: reading,
        told: await read($, told),
        proposal: await read($, proposal),
        config,
        engineVersion,
        versionNote,
        lastError,
      })
    })

    return { text: text ?? `compact-warning could not read its status: ${lastError ?? 'unknown'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stored = await read($, proposal)
    const isQuiet =
      e.props.hasSurvey || stored === null || !stored.isHandedOver || (await read($, isRowHidden))

    if (isQuiet) {
      return next(e)
    }

    const reading = await read($, gauge)
    const at = reading === null ? '' : ` (${reading.percent}% of the auto-compaction point)`
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text>
          Ready to compact{at}. Press Enter on the /compact line, or type /compact: the saved
          instructions apply either way.{' '}
        </Text>
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
        <Text> </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isRowHidden, () => true)} />
      </Box>
    )
  })
}
