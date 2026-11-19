---
name: run-compact-warning
description: Run, start and drive the compact-warning mod in a real Claude Code session, and read its screen as text. Use when asked to run, start, test or check the mod, to see or "screenshot" its start line, status line, toast, report or row above the prompt, or to rehearse an install.
---

compact-warning is a mod for Claude Code, so "running it" means a real Claude Code session
with the mod loaded. Drive one with `.claude/skills/run-compact-warning/driver.py`: it runs
`claude --plugin-dir <this repository>` in a pseudo-terminal in the background, and keeps
the screen as text.

All paths are relative to the repository root. Run the commands from there.

## Prerequisites

- `claude`, logged in. The driver starts real sessions on Haiku.
- `uv`. The driver is a single-file uv script; uv fetches Python and its one dependency.

Checked on macOS with Claude Code 2.1.328. This machine has no tmux, which is why the
driver exists.

## Run (agent path)

Pick a folder for the driver's files. In a Claude Code session, use one in the session's
scratchpad.

```bash
D=/path/to/a/folder/for/this/run
```

Start a session. The command returns when the session is at its prompt, and prints the
screen. It accepts the trust dialog of the new work folder by itself.

```bash
.claude/skills/run-compact-warning/driver.py --dir "$D" start -- --strict-mcp-config --allowedTools 'Bash(ls:*)'
```

The start line of the mod is on that screen:

```text
✓ compact-warning is working · nudges at 774k and 851k tokens · auto-compact at 967k
```

Type, press a key, and wait for the screen. `send` types without Enter.

```bash
.claude/skills/run-compact-warning/driver.py --dir "$D" send '/compact-warning'
.claude/skills/run-compact-warning/driver.py --dir "$D" key enter
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for 'Health:'
```

End the session:

```bash
.claude/skills/run-compact-warning/driver.py --dir "$D" stop
```

| Command | What it does |
|---|---|
| `start [-- <claude arguments>]` | Starts the session in the background, in `$D/work`. |
| `send <text>` | Types text into the prompt box. |
| `key <name>` | Presses `enter`, `escape`, `tab`, `up`, `down`, `left`, `right`, `ctrl-c` or `ctrl-l`. |
| `wait --for <regex> [--timeout 30] [--colors]` | Waits until the screen matches, then prints it. Exit code 1 on a timeout. |
| `show [--colors]` | Prints the screen. |
| `stop` | Ends the session. |

The screen is also in `$D/screen.txt`. `--colors` and `$D/colors.txt` mark each run of text
with its color, for example `{4eba65}✓ compact-warning is working{999999} · nudges at …`.

### See a nudge

The first nudge normally comes at 80% of the auto-compaction point. Bring it to the first
tool call:

```bash
.claude/skills/run-compact-warning/driver.py --dir "$D" send '/compact-warning warn 1k'
.claude/skills/run-compact-warning/driver.py --dir "$D" key enter
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for 'Set warn to 1k'
.claude/skills/run-compact-warning/driver.py --dir "$D" send 'Run ls with the Bash tool, then reply with the word OK. A note that begins with [compact-warning] will arrive: do not act on it.'
.claude/skills/run-compact-warning/driver.py --dir "$D" key enter
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for 'looking for a breakpoint' --timeout 90
```

The screen then has the toast at the top right and the status line under the prompt:

```text
⚠ compact-warning: context at 5% of auto-compact · looking for a breakpoint
```

### See a proposal and compact

```bash
.claude/skills/run-compact-warning/driver.py --dir "$D" send 'Act on the note now: this is a good breakpoint and the project keeps no state document. Propose the compaction with short instructions, then end your turn.'
.claude/skills/run-compact-warning/driver.py --dir "$D" key enter
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for '/compact ready' --timeout 120
.claude/skills/run-compact-warning/driver.py --dir "$D" key ctrl-c
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for 'Ready to compact at'
.claude/skills/run-compact-warning/driver.py --dir "$D" send '/compact'
.claude/skills/run-compact-warning/driver.py --dir "$D" key enter
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for 'Compacted' --timeout 150
```

### Put the settings back

A setting you change stays in the mod's store for later runs. Before `stop`:

```bash
.claude/skills/run-compact-warning/driver.py --dir "$D" send '/compact-warning reset'
.claude/skills/run-compact-warning/driver.py --dir "$D" key enter
.claude/skills/run-compact-warning/driver.py --dir "$D" wait --for 'back to their defaults'
```

## Run without a session's screen

The report needs no model call and no driver. It shows the limit and where the nudges come:

```bash
CLAUDE_CODE_PLUGIN_DIRS="$PWD" claude -p "/compact-warning" --model haiku --no-session-persistence --strict-mcp-config
```

For a small window, where auto-compaction fires at 167k tokens:

```bash
CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 CLAUDE_CODE_PLUGIN_DIRS="$PWD" claude -p "/compact-warning" --model haiku --no-session-persistence --strict-mcp-config
```

## Test

```bash
tools/check
```

It runs the strict validation, with the type check, and the tests. It needs no login.

```bash
tools/live-check
```

Three headless Haiku sessions, about four minutes, about eight cents. To run one of them,
name it: `tools/live-check subagents`. It uses the installed mod. For this working copy,
when it is not the installed one:

```bash
CLAUDE_CODE_PLUGIN_DIRS="$PWD" tools/live-check
```

After a change to `driver.py`, in `.claude/skills/run-compact-warning/`:

```bash
uvx ruff format --check driver.py && uvx ruff check driver.py && uvx --python 3.13 --with pyte mypy driver.py
```

## Rehearse an install

Once a release is on GitHub, install it into an empty config folder. This needs no login
and leaves your own config alone:

```bash
CLAUDE_CONFIG_DIR="$D/config" claude plugin install compact-warning --marketplace atteahma/compact-warning
CLAUDE_CONFIG_DIR="$D/config" claude plugin list
```

## Gotchas

- **A session started from inside Claude Code inherits the parent's identity.** The driver
  drops those variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and the like). It keeps
  variables that set up a test, such as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- **A new folder brings up the trust dialog, with "No, exit" chosen.** `start` presses Down
  and Enter. If you start a session another way, do the same.
- **`--plugin-dir` beats the installed mod of the same name.** The session runs this
  working copy. It keeps its settings in its own store file,
  `~/.claude/plugins/store/compact-warning_inline-*.json`, apart from the installed mod's.
- **The session reloads the mod when you save a file under `hooks/`.** The transcript shows
  `compact-warning: reloaded`, and the start check runs again.
- **A long `/compact` line hides the row above the prompt.** Claude Code gives the rows
  above the prompt what the prompt box leaves. `key ctrl-c` empties the box, and the
  "Ready to compact" row shows.
- **`wait --for` reads the whole screen as one text.** `$` matches only at its end, so
  match on a phrase, not on the end of a line. Pick a phrase that only the thing you wait
  for has: the toast says "Ready to compact." and the row says "Ready to compact at".
- **The screen can come out garbled** after a compaction or a long answer: the emulator
  does not follow every redraw of Claude Code. `wait` asks for a full redraw every two
  seconds while nothing matches. Before a `show`, press `key ctrl-l` yourself.
- **A stray `u` in the first line of the screen** is a terminal query that the driver's
  emulator does not answer. Ignore it.
- **An install from a local repository** needs a smart HTTP server (`git http-backend`).
  Claude Code refuses `file://`, and clones shallow, which a static file server cannot
  serve. A folder path works, but Claude Code then reads the folder in place and skips the
  `engines` check.

## Troubleshooting

- **`no session runs in <dir>: start one first`**: `send`, `key` or the session's end came
  before `start`, or the session has exited. Run `start`.
- **`a session already runs in <dir>: stop it first`**: run `stop`, or use another folder.
- **`timed out waiting for '<pattern>'`**: the command still prints the screen. Read it: a
  dialog may be open, or the model may still be working. `$D/driver.log` has the driver's
  own errors.
- **The start line says `compact-warning is off`**: this Claude Code is older than the
  mod's floor. Nothing else will happen in that session.
