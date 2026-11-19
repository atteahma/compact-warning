# Compaction: stop at a breakpoint and hand over

Apply this when the `compact-warning` mod says the context is filling up, or when the user
asks you to prepare a compaction. The mod senses and triggers. Choosing the breakpoint and
writing the hand-over is your judgment.

## Before any nudge

If the project keeps a status document, keep it current as you work. If it is current, the
summary only has to send the session back to it.

## When the mod nudges

- **First nudge:** keep working, and look for a good breakpoint.
- **Second nudge:** stop at the next breakpoint. Start no new piece of work.

A good breakpoint: a verified piece of work is committed, no command is half-run, and no
answer from a subagent or a background task is about to arrive.

## At the breakpoint

1. Write the state where the project keeps it: its status document, a commit. Never only in
   a scratch folder. If the project has no such place, create none: let the instructions
   say what state the summary must keep.
2. Call `mcp__compact-warning__propose_compact` with the instructions for the summary. Load
   the tool with ToolSearch first if its schema is not loaded.
3. End your turn with one or two lines. The mod puts `/compact <instructions>` in the prompt
   box, and the user presses Enter. If nobody is there, the automatic compaction uses the
   same instructions.

If the tool does not exist, the mod is not loaded. Then print the `/compact <instructions>`
line in the chat for the user to paste, and say that the mod is missing.

## The instructions

Say what to keep, most important first, then what to drop. Aim for 3000 characters: point at
documents, do not repeat them.

1. Your role and the agreed plan, with what not to start.
2. Where the truth is: the document and section to read first after the compaction.
3. The live state: what is running, by id, and what to do when each finishes.
4. How to do the repeated step: the exact commands.
5. The nevers.
6. What is still owed.
7. The user's decisions that shape everything.
8. Drop: content already written into documents, tool output, back-and-forth.

Point 2 does most of the work.
