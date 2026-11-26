# compact-warning

A [mod](https://code.claude.com/docs/en/plugins/mods/overview) for Claude Code that warns
Claude before auto-compaction. Claude stops at a good breakpoint, writes down its state, and
hands you a ready `/compact` line with instructions for the summary.

Without it, auto-compaction fires wherever the session happens to be, and the summary can
lose what the work needs.

## Install

```sh
claude plugin install compact-warning --marketplace atteahma/compact-warning
```

Then turn on updates, once: in a session, run `/plugin`, go to **Marketplaces**, select
`compact-warning`, and choose **Turn on auto-update**.

Claude Code ships almost daily, and an update can break a mod. With auto-update on, a fix
reaches you by itself. Without it, you get a fix only when you run the update command at
the end of this page. `/compact-warning` shows which of the two holds.

- **It needs** Claude Code 2.1.325 or later. On an older one the mod turns itself off and
  says so.
- **The mod itself needs no setup,** and the install asks for nothing.
- **New sessions load it.** In a session that is already open, run `/reload-plugins`.

A scheduled check runs the mod's tests against the newest Claude Code. The badge shows its
latest run:
[![check](https://github.com/atteahma/compact-warning/actions/workflows/check.yml/badge.svg)](https://github.com/atteahma/compact-warning/actions/workflows/check.yml)

## How it works

The mod measures the context against the **auto-compaction point**: the token count where
auto-compaction fires, 967k on a 1M window.

| When | What happens |
|---|---|
| The context reaches 80% of that point | The mod tells Claude to look for a good breakpoint. |
| It reaches 88% | The mod tells Claude to stop at the next breakpoint. |
| At the breakpoint | Claude writes its state where your project keeps it. Then it proposes a compaction: instructions that say what the summary must keep and what it can drop. |
| The turn ends | `/compact <instructions>` is in your prompt box. Press Enter. |
| Claude Code compacts by itself first | That compaction uses the same instructions. |

A good breakpoint: verified work is committed, no command is half-run, and no subagent or
background task is about to report.

- **Each nudge is sent once.** It travels with a tool result or a prompt, so it reaches
  Claude in the middle of a long turn.
- **A draft you are typing stays.** Run `/compact` when you are ready: the saved
  instructions apply.
- **If you keep working, the proposal waits.** Claude renews it when the state changes. A
  compaction that uses an old proposal tells the summary that the later conversation wins.
- **Work that is still running is named.** If a subagent or a background task has not
  finished, Claude is told, so that its instructions can say what to do with the report.
- **Claude is told to create no new files.** If your project has no place for the state,
  the instructions carry it.

### Subagents

A subagent has nobody at a prompt: Claude Code compacts it by itself when its context is
full. The mod makes that compaction follow the subagent's own instructions.

| When | What happens |
|---|---|
| 50k tokens remain before a subagent's auto-compaction | The mod asks the subagent for its instructions. The subagent writes them and keeps working. |
| Claude Code compacts the subagent | That compaction uses the instructions. |

Nothing of this shows in your session, and the main conversation is not interrupted. This
part needs Claude Code 2.1.326 or later. On 2.1.325, `/compact-warning` says that subagents
are not asked.

## What you see

When a session starts, above the prompt for 10 seconds:

```text
✓ compact-warning is working · nudges at 774k and 851k tokens · auto-compact at 967k
```

From the first nudge until the compaction, under the prompt:

```text
⚠ compact-warning: context at 82% of auto-compact · looking for a breakpoint
⚠ compact-warning: context at 89% of auto-compact · stopping at the next breakpoint
⚠ compact-warning: context at 89% of auto-compact · /compact ready
```

While a proposal waits, above the prompt. A long `/compact` line in the prompt box leaves
this row no room, and it then stays away:

```text
Ready to compact at 89% of auto-compact. Run /compact: the saved instructions apply.  [ Fill prompt ] [ Hide ]
```

A toast also marks each nudge and the ready `/compact` line. At any time, `/compact-warning`
prints a report:

```text
Health: working
Context: 116k of 967k tokens, 12% of auto-compact
Nudges: at 774k and 851k tokens, none sent yet
Settings: warn 80%, stop 88%, reserve 30k, unattended off, subagents on
To change one: /compact-warning stop 300k
For this project only: /compact-warning project stop 300k
Claude Code: 2.1.328
Updates: automatic
Proposal: none
```

## Settings

Everything works without them. To change one, give `/compact-warning` the setting and its
value. The change holds at once, for every session on this machine. A project can also have
settings of its own: see [For one project](#for-one-project).

```text
/compact-warning stop 300k
/compact-warning unattended on
/compact-warning reset
```

| Setting | Default | Meaning |
|---|---|---|
| `warn` | 80% | The first nudge: a percentage of the auto-compaction point, or a context size such as `250k`. |
| `stop` | 88% | The second nudge, in the same two forms. |
| `reserve` | 30k | Room for the hand-over. On a small window, both nudges come earlier, so that this many tokens remain before auto-compaction. `0` turns it off. |
| `unattended` | off | On: when the turn with the proposal ends, the mod compacts and tells Claude to continue. Off: it fills the prompt box and waits for Enter. |
| `subagents` | on | On: a subagent is asked for its instructions before Claude Code compacts it. Off: subagents are left alone. |

- **To compact near 300k tokens on a 1M window,** set `warn` to `250k` and `stop` to
  `300k`. A token count never comes later than the default percentage, so a small window
  stays covered.
- **The reserve matters on a small window.** Where auto-compaction fires at 167k tokens,
  88% would leave 20k. The nudges come at 124k and 137k instead.
- **To move auto-compaction itself,** set Claude Code's own `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
  The mod follows it.
- **With auto-compaction off,** the mod measures against the whole context window.
- **To change what Claude does at a breakpoint,** add a rule of your own. A starting point:
  copy [`docs/compact-breakpoint.md`](docs/compact-breakpoint.md) to `~/.claude/rules/` and
  edit it.

### For one project

Put `project` before a setting to change it only for the project you are in:

```text
/compact-warning project stop 300k
/compact-warning project reset
```

- **A project is the folder the session runs in.** Its settings also hold in the folders
  inside it, and in a worktree that Claude Code made of it.
- **A project's setting wins over the machine's.** Where projects nest, the nearest one
  wins.
- **The settings stay on this machine.** Nothing is written into the project.
- **`project reset` removes them.** Plain `reset` leaves them, and puts only the machine's
  settings back.
- **`/compact-warning` shows them,** one line for each folder that sets something.

## If something looks wrong

An update of Claude Code can break a mod. A hook that fails is skipped: the session
carries on with plain auto-compaction.

| You see | It means | What to do |
|---|---|---|
| No green line when a session starts | The mod is not loaded, or its start check failed. An update of Claude Code can cause either. | Update the mod, as shown below, and start a new session. If the line is still missing, run `/compact-warning`. If Claude Code does not know the command, check `claude plugin list`. |
| `compact-warning is off` when a session starts | Your Claude Code is older than 2.1.325. | Update Claude Code. Its stable channel gets a version later than its latest channel. |
| `error in <hook>: <message>` under the prompt | A hook of the mod failed. | Update the mod, as shown below. If the error stays, open an issue with the message. |

An organization that manages Claude Code can block mods that its users install.

## Update or remove

```sh
claude plugin update compact-warning@compact-warning
claude plugin uninstall compact-warning@compact-warning
```

- **An update reaches the sessions you start after it.**
- **To get updates by themselves,** turn on auto-update, as the Install section says.
- **A release can need a newer Claude Code.** An update then keeps the newest release that
  works on yours.

[`CHANGELOG.md`](CHANGELOG.md) lists the releases.

## Development

[`docs/development.md`](docs/development.md) describes the code, the checks and the hooks.
