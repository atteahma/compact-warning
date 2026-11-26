# Changelog

Each release names the Claude Code versions it was checked on. Claude Code ships almost
daily, so a release can stop working on a later version. The daily check in this repository
shows when that happens.

## 0.4.0

Checked on Claude Code 2.1.332. The tests also pass on 2.1.325, the oldest version it runs
on.

- **Settings for one project.** `/compact-warning project stop 300k` changes a setting for
  the project you are in. It also holds in the folders inside it, and in a worktree that
  Claude Code made of it.
- **A project's setting wins over the machine's.** Where projects nest, the nearest one
  wins, setting by setting.
- **Nothing is written into the project.** Its settings stay in the mod's store on this
  machine.
- **`/compact-warning project reset` removes them.** Plain `reset` puts only the machine's
  settings back, and says when a project keeps its own.
- **The report shows them,** one line for each folder that sets something. A change to the
  machine's setting says when a project's setting overrides it.

## 0.3.1

Checked on Claude Code 2.1.330. The tests also pass on 2.1.325, the oldest version it runs
on.

- **The mod works on Claude Code 2.1.325 again.** Release 0.3.0 raised the floor to 2.1.326
  for its subagent part, and so turned the whole mod off on 2.1.325. Now only the subagent
  part needs 2.1.326. On 2.1.325, `/compact-warning` says that subagents are not asked.

## 0.3.0

Checked on Claude Code 2.1.328 and 2.1.330. The tests also pass on 2.1.326, the oldest
version it runs on.

- **A subagent's compaction follows the subagent's own instructions.** When 50k tokens
  remain before Claude Code compacts a subagent, the mod asks the subagent what the summary
  must keep. The subagent answers and keeps working, and the compaction uses its answer.
  Before, a subagent's compaction ran without instructions.
- **A setting turns that off.** `/compact-warning subagents off` leaves subagents alone.
- **Claude Code 2.1.326 or later.** Older versions do not tell a mod how full a subagent's
  context is. On Claude Code 2.1.325, an update keeps release 0.2.1.
- **The live check covers subagents.** `tools/live-check` runs a third session, and takes
  the names of the checks to run.

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
