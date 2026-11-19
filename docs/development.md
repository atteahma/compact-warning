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

For the editor's types, run `claude --plugin-dir .` in the clone once and exit. Claude Code
then writes its API types to `.claude-plugin/types/`.

## The checks

| Script | What it does | Cost |
|---|---|---|
| `tools/check` | Runs `claude plugin validate --strict`, which also checks the types, and the tests. It needs no login. | A few seconds, free |
| `tools/live-check` | Runs two headless Haiku sessions. The first starts a background command and proposes twice: the tool must name the command while it runs, and not after it ended. The second proposes a compaction, then reads a large file until Claude Code compacts by itself: that compaction must receive the proposal. It needs a login. | About two minutes, a few cents |
| `tools/version-guard <commit>` | Fails when the mod's code changed since that commit and its version did not. | Free |

- **`tools/check` after every change.** The tests run against stand-ins, so they are fast.
- **`tools/live-check` before a release.** Only a real session shows a change in Claude
  Code's own behavior. It uses the installed mod. To check another copy, name its folder in
  `CLAUDE_CODE_PLUGIN_DIRS`.
- **To look at the mod in a real session,** use the driver in
  `.claude/skills/run-compact-warning/`. Its `SKILL.md` has the commands, and Claude Code
  offers it as the skill `/run-compact-warning` in this repository.

## Releases

Every commit on `main` that changes the mod's code is a release. An installed copy moves
only when the version changes, so such a commit must raise it.

1. In the commit that changes `hooks/`, `types/` or the manifest, raise `version` in
   `.claude-plugin/plugin.json` and add the release to `CHANGELOG.md`.
2. Land it on `main`.
3. Run `tools/release`. It runs both checks and tags the commit `compact-warning--v<version>`.
4. Run `tools/release --push`, or push `main` and the tag by hand.

The tag matters. When a later release needs a newer Claude Code, a person on an older one
still gets the newest tagged release that fits. Claude Code looks up to five tags back.

A change to the README or the docs needs no release.

## The daily check

`.github/workflows/check.yml` runs `tools/check` on every push, and once a day, against
Claude Code's `latest` and `stable` channels. Claude Code ships almost daily. A red run on
a day without a push means that a new Claude Code broke the mod: fix it, and release.

The workflow also runs `tools/version-guard` on a push and on a pull request.

**The tests alone can stay green while a real session fails.** They run against stand-ins.
So the workflow has a third job, the live check. It runs `tools/live-check` once a day and
when you start the workflow by hand. It needs a login, which a repository secret gives:

```sh
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

The first command makes a long-lived token for a Claude subscription. The second asks for
it and stores it as the secret. Without the secret the job says that it did not run, and
passes. Each run costs what two short Haiku sessions cost, against that subscription.

**The schedule can stop.** In a public repository, GitHub turns scheduled workflows off
after 60 days without activity in the repository. Its docs give the reason: "to prevent
unnecessary workflow runs". To turn the schedule on again, open the Actions tab, or run
`gh workflow enable check.yml`.

- **The workflow has no step that keeps itself alive, on purpose.** GitHub has taken down
  the best-known action that did that, for a violation of its terms.
- **While the schedule is off, the badge in the README shows the last run,** however old
  it is. `tools/release` still runs the same checks before every release.

## Which Claude Code the mod runs on

The floor is stated twice, and `tools/check` fails when the two differ:

- **`engines` in the manifest.** From 2.1.323, Claude Code does not install, update or load
  a mod outside its range.
- **`MIN_VERSION` in `hooks/logic.ts`.** An older Claude Code does not read `engines` and
  loads the mod anyway. There the mod turns itself off: its hooks pass every event on, the
  start line says `compact-warning is off`, and `/compact-warning` says why.

On a Claude Code older than the floor, `tools/check` checks the manifest only.

At a session start the mod runs a start check: it registers its tool and command, and reads
the context's size and limit. The green line shows only when all of that worked.

## How a fix reaches someone who installed

It does not, by itself. For a marketplace like this one, Claude Code's auto-update is off
until each person turns it on, the install command has no flag for it, and
`marketplace.json` has no field for it. So:

- **The README's Install section has the step,** with the label Claude Code shows.
- **One notice at a session start,** once per person, when their copy is updated by hand.
- **The report says how updates arrive.** An installed copy sits under
  `<config>/plugins/cache/<marketplace>/`, which gives the mod its marketplace's name. The
  switch has two homes: `extraKnownMarketplaces` in the settings, and Claude Code's own
  `plugins/known_marketplaces.json`. The settings win. A copy that Claude Code reads from a
  folder gets no such line.

## The length of a proposal

The tool's description tells the model to aim for 3,000 characters. The tool takes up to
4,500, and the model is never told that number.

- **The model writes up to the number it is given.** In 49 real proposals against a stated
  4,000, the drafts ran from 3,700 to 4,858 characters: up to a fifth over.
- **A refusal at the stated number fails half the time.** 24 of those 49 were refused, each
  a full draft written twice while the context was nearly full.
- **Only a runaway draft is refused,** with a share to cut, which is easier to hit than a
  count of characters.

## The settings

The mod declares no `userConfig`, because Claude Code asks for every such option at
install, also for one with a default. The settings live in the mod's store instead, under
the key `settings`.

- **The store holds only what the person changed.** A setting they never touched follows the
  default of a later release.
- **Every session reads the store again after ten seconds,** so a change reaches them all.
- **A value that does not fit is left out** when the store is read: the store outlives a
  release.

## The files

| File | What it holds |
|---|---|
| `hooks/register.tsx` | The hooks: every call to Claude Code. |
| `hooks/logic.ts` | The decisions, and every text the mod shows. It makes no calls to Claude Code, so the tests can check it alone. |
| `types/index.d.ts` | The contract for the values the mod keeps in the session's state. |
| `tests/logic.test.ts` | The tests of the decisions. |
| `tests/register.test.ts` | The tests of the hooks, run against Claude Code's test kit. |
| `docs/compact-breakpoint.md` | An optional rule for the model. The mod works without it. |
| `tools/` | The checks and the release script. |
| `.claude/skills/run-compact-warning/` | A driver that runs the mod in a real Claude Code session, and its instructions. |
| `.github/workflows/check.yml` | The daily check. |

## The hooks

| Hook event | What the mod does there |
|---|---|
| `session.start` | Registers the command and the tool, checks the floor, runs the start check, shows the start line. |
| `tool.call` | Reads the context after each tool, and adds a nudge to the result. Notes the background tasks that tools start. Skips subagents. |
| `prompt.submit` | Does the same at a prompt, and reminds the model while a proposal waits. Forgets a background task when its notification says it ended. |
| `turn.complete` | Hands the proposal over: fills the prompt box, or compacts when `unattended` is on. |
| `session.compact` | Passes the proposal on when you typed no instructions. Refuses a summary computed ahead of time. Clears the state afterwards. |
| `session.end` | Clears the state on `/clear`. |
| `session.measure` | Redraws the status line. |
| `command.run` | Answers `/compact-warning`: the report, or a change to a setting. |
| `ui.render` | Draws the start line and the "Ready to compact" row. |

Every hook passes its event on unchanged when the mod's own work fails.

## Where the nudges come

`thresholdsOf` in `hooks/logic.ts` decides, in this order:

1. A nudge set as a percentage comes at that share of the limit. One set as a token count
   comes at that size, and never later than its default percentage.
2. If fewer than `reserve` tokens would remain after the second nudge, both nudges come
   earlier by the same amount. The reserve takes a quarter of the limit at most.
3. The first nudge never comes after the second.

The limit is the auto-compaction point. While auto-compaction is off, it is the whole
context window.

## Limits by design

- **A session that never reaches a breakpoint.** The mod cannot pick one. The context then
  fills, and auto-compaction runs with the last proposal, or with none.
- **Subagents.** The mod leaves a subagent's own context alone. Subagents compact by
  themselves.
- **Work that is still running.** The mod never waits for a subagent or a background task.
  Its report can arrive after the compaction, so the instructions must cover it.
- **Slower compaction.** Claude Code can compute a summary ahead of time. Such a summary
  cannot follow later instructions, so the mod refuses it. A compaction then writes its
  summary when it runs.
- **A reading one step behind.** The context's size is the input size of the last response.
- **Settings per machine.** They live in the mod's own store, not in `settings.json`. Claude
  Code drops a store that no session used for its cleanup period, and the settings then
  return to their defaults.

## What the mod cannot see

- **Its own failure to load.** When Claude Code refuses the module, for example after an
  event was renamed, it writes that to the debug log only. The missing green line is the
  only sign in the session. `claude plugin validate` reports it, so the daily check does.
- **Background tasks.** Claude Code gives a mod a list of the session's agents, but none of
  its background commands, workflows and monitors. The mod keeps its own list from the tool
  results that start them and the notifications that end them. The list starts empty when
  the mod loads, so it misses a task that was started before.
- **The text of a notification.** Claude Code does not document it. If an update changes
  it, a finished task stays listed as still running. `tools/check` cannot see that, and
  `tools/live-check` can.
