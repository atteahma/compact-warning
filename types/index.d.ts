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

/** One reading of the context window against the auto-compaction point. */
export type Gauge = {
  /** Input tokens of the last response. */
  tokens: number
  /** The token count where auto-compaction fires. */
  limit: number
  /** `tokens` as a whole percentage of `limit`. */
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'compact-warning': {
      told: Told
      proposal: Proposal | null
      gauge: Gauge | null
      isRowHidden: boolean
    }
  }
}
