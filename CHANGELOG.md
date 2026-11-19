# Changelog

Each release names the Claude Code versions it was checked on. The mod API is early access,
so a release can stop working on a later Claude Code. The daily check in this repository
shows when that happens.

## 0.2.1

Checked on Claude Code 2.1.328.

- **The report says how updates arrive.** `/compact-warning` shows `Updates: automatic`, or
  `Updates: by hand` with the way to turn auto-update on. A fix for a break that a new
  Claude Code causes reaches nobody who updates by hand.
- **One notice about updates.** A copy that is updated by hand says so once, when a
  session starts.
- **The fix command names your marketplace.** When a hook fails, the report shows the
  update command for the marketplace your copy came from.
- **Proposals pass on the first try.** Claude is told to aim for 3,000 characters, and the
  tool takes up to 4,500. Before, it refused every proposal over 4,000, which was half of
  them: Claude writes up to the number it is given, and a little over.

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
