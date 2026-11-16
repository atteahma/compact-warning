# compact-warning

A Claude Code mod that warns a session before auto-compaction. The session then stops at a
good breakpoint, writes its state down, and hands you a ready `/compact` line.

This README is for someone who uses Claude Code and wants to install, check or change the
mod. It assumes you know what compaction and hooks are.

## What it does

1. **It senses.** After every tool call and at every prompt of the main conversation, the
   mod reads how full the context is. It measures against the token count where
   auto-compaction fires (about 967 000 on a 1M window), not against the full window.
2. **It nudges the model, once per threshold.** At 80% it says: look for a breakpoint. At
   88% it says: stop at the next one. The note travels with a tool result or a prompt, so
   it arrives in the middle of a long turn.
3. **The model proposes.** At the breakpoint the model writes its state where the project
   keeps it. Then it calls the tool `mcp__compact-warning__propose_compact` with the
   instructions for the summary.
4. **It hands over.** When that turn ends, the mod puts `/compact <instructions>` in the
   prompt box, and you press Enter. A draft you are typing stays: type `/compact`, and the
   saved instructions are used.
5. **It backs you up.** If an automatic compaction fires first, it uses the same
   instructions. The mod never blocks a compaction.

After a compaction, a `/clear` or a rewind, the mod starts over.

## What you see

| Where | What |
|---|---|
| Status line under the prompt | `context 42% of auto-compact`, always. It adds `looking for a breakpoint`, `stopping at the next breakpoint` or `/compact line ready`. |
| Toast | One at each nudge, and one when the `/compact` line is ready. |
| Row above the prompt | "Ready to compact", with the buttons **Fill prompt** and **Hide**, while a proposal waits. |
| `/compact-warning` | Prints the reading, the thresholds, the stored proposal and the last error. |

### If the mod stops working

The mod uses an early-access part of Claude Code that can change with any update. Claude
Code skips a mod that fails, and in a normal session it reports that only in the debug log.
So the mod shows its own health:

- **No status line means the mod is not running.** Run `tools/check` (below).
- **`mod untested on Claude Code <version>`** in the status line means Claude Code was
  updated since the checks last passed. Run `tools/check`.
- **`mod error in <hook>: <message>`** in the status line means a hook of the mod failed.
  The session still works, with plain auto-compaction.

## Install

The mod installs from this folder, at user scope, so every new session loads it:

```sh
claude plugin marketplace add ~/repos/typescript/compact-warning
claude plugin install compact-warning@compact-warning --scope user
```

A session that was already running loads it after `/reload-plugins`.

Claude Code reads the mod from this folder, not from a copy. After an edit here, run
`/reload-plugins` in a session to load the change.

The model also needs the rule that says what a good breakpoint is and how to write the
instructions. Copy it to where your global rules live:

```sh
cp docs/compact-breakpoint.md ~/.claude/rules/
```

## Options

Set them in `/config`, or with `--config <key>=<value>` at install.

| Option | Default | Meaning |
|---|---|---|
| `warnPercent` | 80 | First nudge, as a percentage of the point where auto-compaction fires. |
| `stopPercent` | 88 | Second nudge. Never lower than the first. |
| `unattended` | off | On: when the model proposes, the mod compacts at once and sends the session a prompt to continue. Off: it fills the prompt box and waits for Enter. |

The nudges come early on purpose. Writing the state down costs tokens, and one large tool
result can take 1% of a 1M window.

## After a Claude Code update

```sh
tools/check
```

It runs `claude plugin validate`, the type check and the tests against the installed
Claude Code. When they pass, it writes the version to `tested-version.txt`, and the
`untested` flag leaves the status line at the next session start.

The type check needs the API types of the installed version in `.claude-plugin/types/`.
The script says when they are missing or old. To refresh them, run `claude --plugin-dir .`
in this folder once and exit.

## How it is built

| File | What it holds |
|---|---|
| `hooks/register.tsx` | The hooks: every call to the engine. |
| `hooks/logic.ts` | The decisions and every text the mod shows, with no engine calls. |
| `types/index.d.ts` | The contract for the values the mod keeps in the session's state. |
| `tests/` | `logic.test.ts` checks the decisions; `register.test.ts` runs the hooks against the engine. |
| `docs/compact-breakpoint.md` | The rule for the model. |
| `tools/check` | The checks to run after an update. |

| Event | What the mod does there |
|---|---|
| `session.start` | Registers the tool and the command, compares versions, draws the status line. |
| `tool.call` | Reads the fill after the tool ran, and adds the nudge to the result. Skips subagents. |
| `prompt.submit` | The same at a prompt. Reminds the model while an offered proposal is unused. |
| `turn.complete` | Offers the proposal: fills the prompt box, or compacts when `unattended` is on. |
| `session.compact` | Passes the stored instructions on when none were typed. Clears the state afterwards. |
| `session.end` | Clears the state on `/clear`. |
| `session.measure` | Redraws the status line. |

Every hook passes its event on unchanged when the mod's own work fails.

## Limits

- It cannot pick a breakpoint for a session that never reaches one, for example one command
  that runs for an hour while the context fills from other sources.
- It does not protect a subagent's own context. Subagents compact by themselves.
- A summary that Claude Code computed ahead of time may predate the proposal. The mod
  passes the instructions on at every compaction, but it cannot make the engine recompute.
- The reading is the input size of the last response, so it lags by one step.
