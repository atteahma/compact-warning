# Development

This page is for someone who changes the mod. It assumes you know TypeScript and Claude
Code's [mod API](https://code.claude.com/docs/en/plugins/mods/reference).

## Work on a local copy

1. Clone the repository.
2. Install the mod from the clone, so that Claude Code reads the folder itself:

   ```sh
   claude plugin marketplace add "$PWD"
   claude plugin install compact-warning@compact-warning --scope user
   ```

3. Run `tools/check`.
4. After an edit, run `/reload-plugins` in each open session.

## The checks

| Script | What it does | Cost |
|---|---|---|
| `tools/check` | Runs `claude plugin validate`, the type check and the tests against the installed Claude Code. When they pass, it writes the version to `tested-version.txt`. | A few seconds, free |
| `tools/live-check` | Runs two headless Haiku sessions. The first starts a background command and proposes twice: the tool must name the command while it runs, and not after it ended. The second proposes a compaction, then reads a large file until Claude Code compacts by itself: that compaction must receive the proposal. | About two minutes, a few cents |

Run `tools/check` after every change and after every Claude Code update. Run
`tools/live-check` before a release: the tests run against stand-ins, and only a real
session shows a change in Claude Code's own behavior.

- **The type check** needs `npx`, and the API types of the installed version in
  `.claude-plugin/types/`. `tools/check` says when the types are missing or old. To refresh
  them, run `claude --plugin-dir .` in the clone once and exit.
- **`claude plugin validate` warns that the manifest has no version.** That is on purpose:
  without one, an installed copy follows the commits. Every push to `main` is a release.
- **To check a copy that is not installed,** set `CLAUDE_CODE_PLUGIN_DIRS` to its folder
  when you run `tools/live-check`.

## The version check

In a clone, the mod compares the running Claude Code version with `tested-version.txt` at
each session start. On a mismatch it shows `untested on Claude Code <version>` under the
prompt, shows no green line, and `/compact-warning` reports `Health: needs attention`. Run
`tools/check` to clear it.

A copy installed from GitHub has no `tested-version.txt`, so it skips this check. There the
start check alone decides: the mod registers its tool and command, and reads the context's
size and limit. The green line shows only when all of that worked.

## The files

| File | What it holds |
|---|---|
| `hooks/register.tsx` | The hooks: every call to Claude Code. |
| `hooks/logic.ts` | The decisions, and every text the mod shows. It makes no calls to Claude Code, so the tests can check it alone. |
| `types/index.d.ts` | The contract for the values the mod keeps in the session's state. |
| `tests/logic.test.ts` | The tests of the decisions. |
| `tests/register.test.ts` | The tests of the hooks, run against Claude Code's test kit. |
| `docs/compact-breakpoint.md` | An optional rule for the model. The mod works without it. |
| `tools/check`, `tools/live-check` | The checks. |

## The hooks

| Hook event | What the mod does there |
|---|---|
| `session.start` | Registers the tool and the command, runs the start check, shows the green line. |
| `tool.call` | Reads the context after each tool, and adds a nudge to the result. Notes the background tasks that tools start. Skips subagents. |
| `prompt.submit` | Does the same at a prompt, and reminds the model while a proposal waits. Forgets a background task when its notification says it ended. |
| `turn.complete` | Hands the proposal over: fills the prompt box, or compacts when `unattended` is on. |
| `session.compact` | Passes the proposal on when you typed no instructions. Refuses a summary computed ahead of time. Clears the state afterwards. |
| `session.end` | Clears the state on `/clear`. |
| `session.measure` | Redraws the status line. |
| `command.run` | Answers `/compact-warning`. |
| `ui.render` | Draws the green line and the "Ready to compact" row. |

Every hook passes its event on unchanged when the mod's own work fails.

## Where the nudges come

`thresholdsOf` in `hooks/logic.ts` decides, in this order:

1. Each nudge comes at its percentage of the limit, or at its token count when that is
   set and comes first.
2. If fewer than `reserveTokens` would remain after the second nudge, both nudges come
   earlier by the same amount. The reserve takes a quarter of the limit at most.
3. The first nudge never comes after the second.

The limit is the auto-compaction point. While auto-compaction is off, it is the whole
context window.

## What the mod cannot see

- **Background tasks.** Claude Code gives a mod a list of the session's agents, but none of
  its background commands, workflows and monitors. The mod keeps its own list from the tool
  results that start them and the notifications that end them.
- **The text of a notification.** Claude Code does not document it. If an update changes
  it, a finished task stays listed as still running. `tools/check` cannot see that, and
  `tools/live-check` can.
- **A hook that fails later.** The start check proves that the mod loaded and can read the
  context. A hook that fails afterwards shows as `error in <hook>` under the prompt.
