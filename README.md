# compact-warning

A Claude Code mod that warns a session before auto-compaction. The session stops at a good
breakpoint, writes its state down, and hands you a ready `/compact` line. Without the mod,
auto-compaction can fire at a bad moment, and its summary can lose state.

This README is for someone who uses Claude Code and wants to install, check or change the
mod. It assumes you know what compaction and hooks are.

## How it works

The mod measures the context against the **auto-compaction point**: the token count where
auto-compaction fires, about 967 000 on a 1M window.

| When | What happens |
|---|---|
| After every tool call and prompt of the main conversation | The mod reads how full the context is. |
| At 80% of the auto-compaction point | The mod nudges the model: look for a good breakpoint. |
| At 88% | The mod nudges the model: stop at the next breakpoint. |
| At the breakpoint | The model writes its state where the project keeps it. Then it calls the tool `mcp__compact-warning__propose_compact` with instructions for the summary: what to keep, most important first, and what to drop. The mod stores them as the proposal. |
| When that turn ends | The mod puts `/compact <instructions>` in the prompt box. You press Enter. |
| If Claude Code compacts by itself first | The compaction uses the proposal. |

- **Each nudge is sent once.** It travels with a tool result or a prompt, so it reaches the
  model in the middle of a long turn.
- **A draft you are typing stays.** Type `/compact` when you are ready, and the mod adds
  the proposal.
- **The mod never blocks a compaction.** After a compaction, a `/clear` or a rewind, it
  starts over.

The rule `docs/compact-breakpoint.md` tells the model what a good breakpoint is and what
the instructions must say.

### If you keep working instead of pressing Enter

The proposal stays stored until a compaction runs, so it can grow old.

- With each prompt, the mod reminds the model to propose again if the state changed.
- Once the context has grown 5 000 tokens past the proposal, the status line shows its age:
  `/compact line ready, 18 000 tokens old`.
- A compaction still uses an old proposal, because most of it stays true: the plan, the
  nevers, your decisions. The mod adds one sentence for the summary: where the later
  conversation differs, the later conversation wins.

Press Enter soon after the line appears.

## What you see

| Sign | Where | When |
|---|---|---|
| Green line | Above the prompt | For 10 seconds after the start check passed. It leaves at your first prompt. |
| Status line | Under the prompt | From the first nudge or proposal until the compaction, and while the mod has a fault. |
| Toast | Top right corner | At each nudge, when the `/compact` line is ready, and when the mod finds a fault. |
| "Ready to compact" row, with the buttons **Fill prompt** and **Hide** | Above the prompt | While a proposal waits. |

The green line:

```text
✓ compact-warning is working. It warns at 80% and 88% of the auto-compaction point (967 000 tokens).
```

The status line, in its three stages:

```text
⚠ compact-warning: context 82% of auto-compact, looking for a breakpoint
⚠ compact-warning: context 89% of auto-compact, stopping at the next breakpoint
⚠ compact-warning: context 89% of auto-compact, /compact line ready
```

Claude Code draws the status line as a warning, so the mod shows none under the first
threshold.

At any time, `/compact-warning` prints a report. Its first line is `Health: working`, or
`Health: needs attention` with the reason. The rest is the context reading, the thresholds,
the proposal and the last error.

## How you know it works

Mods are an early-access part of Claude Code that can change with any update. Claude Code
skips a mod that fails, and a normal session reports that only in the debug log. So the mod
runs a start check when a session starts or resumes, and when `/reload-plugins` loads a
change:

1. It registers its tool and its command.
2. It compares the running Claude Code version with the one `tools/check` last passed on.
3. It reads the context's size and the auto-compaction point.

| You see | It means | What to do |
|---|---|---|
| The green line | The start check passed. | Nothing. |
| No green line at the start | The mod is not loaded, or a check failed. | Run `/compact-warning` and read its first line. If Claude Code does not know the command, the mod is not loaded: run `tools/check`, then `/reload-plugins`. |
| `mod untested on Claude Code <version>` in the status line | Claude Code was updated since `tools/check` last passed. | Run `tools/check`. |
| `mod error in <hook>: <message>` in the status line | A hook of the mod failed. The session still works, with plain auto-compaction. | Run `tools/check`. |

## Install

Run these commands in this folder.

1. Install the mod at user scope, so that every new session loads it:

   ```sh
   claude plugin marketplace add "$PWD"
   claude plugin install compact-warning@compact-warning --scope user
   ```

2. Copy the rule for the model to your global rules:

   ```sh
   cp docs/compact-breakpoint.md ~/.claude/rules/
   ```

3. Run the checks once. Until they pass, the mod reports itself as untested:

   ```sh
   tools/check
   ```

4. Run `/reload-plugins` in each session that was already running.

Claude Code reads the mod from this folder, not from a copy. After an edit here,
`/reload-plugins` loads the change.

## Options

Set the options with `/plugin configure compact-warning@compact-warning` in a session, or
with `--config <key>=<value>` at install. Claude Code stores them in
`~/.claude/settings.json`, under `pluginConfigs["compact-warning@compact-warning"].options`.
A running session picks up a change at once.

| Option | Default | Meaning |
|---|---|---|
| `warnPercent` | 80 | The first nudge, as a percentage of the auto-compaction point. |
| `stopPercent` | 88 | The second nudge. Never lower than the first. |
| `unattended` | off | On: when the turn with the proposal ends, the mod compacts and sends the session a prompt to continue. Off: the mod fills the prompt box and waits for Enter. |

The nudges come early on purpose. Writing the state down costs tokens, and one large tool
result can take 1% of a 1M window.

## After a Claude Code update

Run `tools/check`. For proof from a real session, also run `tools/live-check`.

| Script | What it does | Cost |
|---|---|---|
| `tools/check` | Runs `claude plugin validate`, the type check and the tests against the installed Claude Code. When they pass, it records the version, and the mod stops reporting itself as untested. | A few seconds, free |
| `tools/live-check` | Tests the backup. A headless Haiku session proposes a compaction, then reads a large file until Claude Code compacts by itself. The check passes when that compaction received the proposal. | About a minute, a few cents |

The type check needs `npx`, and the API types of the installed version in
`.claude-plugin/types/`. `tools/check` says when the types are missing or old. To refresh
them, run `claude --plugin-dir .` in this folder once and exit.

## Limits

- **A session that never reaches a breakpoint.** The mod cannot pick one, for example
  during one command that runs for an hour while the context fills from other sources.
- **Subagents.** The mod does not protect a subagent's own context. Subagents compact by
  themselves.
- **Slower compaction.** Claude Code can compute a summary ahead of time and reuse it. Such
  a summary cannot follow instructions written later, so the mod refuses it for the main
  conversation. A compaction then writes its summary when it runs, which takes longer.
- **A reading one step behind.** The reading is the input size of the last response.
- **A collapsed band.** While you have collapsed the band above the prompt (ctrl+x ctrl+a),
  the green line and the "Ready to compact" row do not show.
- **A hook that fails later.** The start check proves that the mod loaded and can read the
  context. A hook that fails afterwards shows as `mod error` in the status line.

## How it is built

The mod is TypeScript on Claude Code's mod API. `register.tsx` makes every call to Claude
Code, and `logic.ts` makes every decision, so the decisions can be tested alone.

| File | What it holds |
|---|---|
| `hooks/register.tsx` | The hooks: every call to Claude Code. |
| `hooks/logic.ts` | The decisions, and every text the mod shows. |
| `types/index.d.ts` | The contract for the values the mod keeps in the session's state. |
| `tests/logic.test.ts` | The tests of the decisions. |
| `tests/register.test.ts` | The tests of the hooks, run against Claude Code's test kit. |
| `docs/compact-breakpoint.md` | The rule for the model. |
| `tools/check`, `tools/live-check` | The checks to run after an update. |

| Hook event | What the mod does there |
|---|---|
| `session.start` | Registers the tool and the command, runs the start check, shows the green line. |
| `tool.call` | Reads the context after the tool ran, and adds a nudge to the result. Skips subagents. |
| `prompt.submit` | Does the same at a prompt. Reminds the model while a proposal waits. Takes the green line away. |
| `turn.complete` | Hands the proposal over: fills the prompt box, or compacts when `unattended` is on. |
| `session.compact` | Passes the proposal on when you typed no instructions. Refuses a summary computed ahead of time. Clears the state afterwards. |
| `session.end` | Clears the state on `/clear`. |
| `session.measure` | Redraws the status line. |
| `command.run` | Answers `/compact-warning`: runs the start check again and prints the report. |
| `ui.render` | Draws the green line or the "Ready to compact" row above the prompt. |

Every hook passes its event on unchanged when the mod's own work fails.
