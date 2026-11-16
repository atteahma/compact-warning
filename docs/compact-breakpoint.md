# Compaction: stop at a breakpoint and hand over

Apply this when the `compact-warning` mod says the context is filling up, or when Atte asks
you to prepare a compaction. The mod senses and triggers. Choosing the breakpoint and
writing the hand-over is your judgement. Atte set this up on 2026-11-15.

## Before any warning

Keep the project's status document current as you work. If it is current, the summary only
has to send the session back to it.

## When the mod warns

- **First warning** (80% of the point where auto-compaction fires): keep working, and look
  for a good breakpoint.
- **Second warning** (88%): stop at the next breakpoint. Start no new piece of work.

A good breakpoint: a verified piece of work is committed, no command is half-run, and no
answer from a subagent or a background task is about to arrive.

## At the breakpoint

1. Write the state where the project keeps it: its status document, a commit. Never only in
   the session's scratch folder.
2. Call `mcp__compact-warning__propose_compact` with the instructions for the summary. Load
   the tool with ToolSearch first if its schema is not loaded.
3. End your turn with one or two lines. The mod puts `/compact <instructions>` in the prompt
   box, and Atte presses Enter. If nobody is there, the automatic compaction uses the same
   instructions.

If the tool does not exist, the mod is not loaded. Then print the `/compact <instructions>`
line in the chat for Atte to paste, and tell him the mod is missing.

## The instructions

Say what to keep, most important first, then what to drop. Stay under 4000 characters.

1. Your role and the agreed plan, with what not to start.
2. Where the truth is: the document and section to read first after the compaction.
3. The live state: what is running, by id, and what to do when each finishes.
4. How to do the repeated step: the exact commands.
5. The nevers.
6. What is still owed.
7. Atte's decisions that shape everything.
8. Drop: content already written into documents, tool output, back-and-forth.

Point 2 does most of the work.
