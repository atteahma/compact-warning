/** The strongest nudge the model has had since the context last shrank. */
export type Told = 'none' | 'warn' | 'stop'

/** The compaction the model proposed, kept until a compaction runs. */
export type Proposal = {
  /** What the summary must keep and drop, as the model wrote it. */
  instructions: string
  /** The context's size in tokens when it was proposed; null when unknown. */
  tokens: number | null
  /** True once the /compact line was offered to the person. */
  isHandedOver: boolean
}

/** One reading of the context against its limit. */
export type Gauge = {
  /** Input tokens of the last response. */
  tokens: number
  /**
   * The token count the context is measured against: where auto-compaction
   * fires, or the whole window while auto-compaction is off.
   */
  limit: number
  /** `tokens` as a whole percentage of `limit`. */
  percent: number
  /**
   * False while auto-compaction is off. Absent in a reading that an older
   * version of the mod stored, which counts as true.
   */
  isAutoCompact?: boolean
}

/** The line that says the start check passed, shown for a few seconds. */
export type Greeting = {
  text: string
  /** The rest of the line, drawn dim. Absent in a value of an older version. */
  detail?: string
  /** When the line leaves, in milliseconds since the epoch. */
  until: number
}

declare module 'claude-code' {
  interface PluginState {
    'compact-warning': {
      told: Told
      proposal: Proposal | null
      gauge: Gauge | null
      isRowHidden: boolean
      greeting: Greeting | null
    }
  }
}
