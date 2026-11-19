# Changelog

Each release names the Claude Code versions it was checked on. The mod API is early access,
so a release can stop working on a later Claude Code. The daily check in this repository
shows when that happens.

## 0.2.0

The first public release. Checked on Claude Code 2.1.328.

- **Install with one line.** The mod needs no setup and asks for nothing.
- **Settings in the mod's own command.** `/compact-warning <setting> <value>` changes
  `warn`, `stop`, `reserve` or `unattended` for every session. `warn` and `stop` take a
  percentage or a token count.
- **Room for the hand-over.** On a small context window both nudges come earlier, so that
  30k tokens remain before auto-compaction.
- **Auto-compaction off.** The mod then measures against the whole context window.
- **Claude Code 2.1.325 or later.** On an older one the mod turns itself off and says why.
- **No new files.** If a project has no place for the session's state, Claude is told to
  create none.
- **Shorter texts.** Token counts read as Claude Code writes them (774k).

## 0.1.0

The first version, used privately. It warned at 80% and 88% of the auto-compaction point,
took a proposal through the `propose_compact` tool, and filled the prompt box with
`/compact <instructions>`.
