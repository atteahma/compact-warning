#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyte>=0.8.2"]
# ///
"""Drives a real Claude Code session with this repository's mod, and keeps its screen as text.

`start` launches `claude --plugin-dir <this repository>` in a pseudo-terminal, in the
background, and accepts the trust dialog. `send` and `key` type into it, `wait` blocks until
the screen matches a pattern, `show` prints the screen, and `stop` ends the session.

The screen is in <dir>/screen.txt, and in <dir>/colors.txt with the color of each run of text.
"""

from __future__ import annotations

import argparse
import codecs
import contextlib
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
from collections.abc import Sequence
from enum import IntEnum, StrEnum
from pathlib import Path
from typing import Final, assert_never

import pyte

REPOSITORY: Final = Path(__file__).resolve().parents[3]
POLL_SECONDS: Final = 0.1
WRITE_SECONDS: Final = 0.3
STOP_SECONDS: Final = 10.0
# While a wait finds nothing, it asks the session to draw its screen again this often.
REDRAW_SECONDS: Final = 2.0
READ_BYTES: Final = 65536
SCREEN_FILE: Final = "screen.txt"
COLORS_FILE: Final = "colors.txt"
LOG_FILE: Final = "driver.log"
PID_FILE: Final = "driver.pid"
QUEUE_DIR: Final = "queue"
WORK_DIR: Final = "work"
QUIT_FILE: Final = "quit"
DEFAULT_COLOR: Final = "default"
TERMINAL: Final = "xterm-256color"
# What marks a parent Claude Code session: a session started from inside one must not
# inherit it. Variables that set up a test, such as CLAUDE_CODE_AUTO_COMPACT_WINDOW, stay.
PARENT_SESSION: Final = frozenset(
    {
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_NOTES_DIR",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_EFFORT",
        "CLAUDE_PID",
    }
)
# Claude Code marks its prompt and the chosen row of a dialog with U+276F.
POINTER: Final = "\u276f"
TRUST_DIALOG: Final = re.compile(r"Yes, I trust this folder")
TRUST_CHOSEN: Final = re.compile(POINTER + r" Yes, I trust this folder")
READY: Final = re.compile(r"compact-warning is (working|off)|^" + POINTER, re.MULTILINE)
KEYS: Final[dict[str, bytes]] = {
    "enter": b"\r",
    "escape": b"\x1b",
    "tab": b"\t",
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "ctrl-c": b"\x03",
    "ctrl-l": b"\x0c",
}


class Exit(IntEnum):
    """The exit codes of this tool."""

    OK = 0
    TIMEOUT = 1
    USAGE = 2
    FAILED = 3


class Command(StrEnum):
    """The commands of this tool."""

    START = "start"
    SEND = "send"
    KEY = "key"
    WAIT = "wait"
    SHOW = "show"
    STOP = "stop"


class DriveError(Exception):
    """A failure to tell the person about, in one line."""


def plain(screen: pyte.Screen) -> str:
    """Return the screen as text, without trailing blanks."""
    return "\n".join(line.rstrip() for line in screen.display).rstrip() + "\n"


def colored(screen: pyte.Screen) -> str:
    """Return the screen with each run of styled text marked as {style}text."""
    rows: list[str] = []

    for y in range(screen.lines):
        row = screen.buffer[y]
        parts: list[str] = []
        style = ""

        for x in range(screen.columns):
            char = row[x]
            marks = [char.fg] if char.fg != DEFAULT_COLOR else []
            marks += ["bold"] if char.bold else []
            marks += ["reverse"] if char.reverse else []
            now = ",".join(marks)

            if now != style:
                parts.append(f"{{{now}}}")
                style = now

            parts.append(char.data)

        rows.append("".join(parts).rstrip())

    return "\n".join(rows).rstrip() + "\n"


def running(folder: Path) -> int | None:
    """Return the process id of the session that this folder holds, if one runs."""
    try:
        pid = int((folder / PID_FILE).read_text(encoding="utf-8"))
        os.kill(pid, 0)
    except (OSError, ValueError):
        return None

    return pid


def serve(folder: Path, rows: int, columns: int, argv: Sequence[str]) -> None:
    """Run argv in a pseudo-terminal until it exits or a stop is asked for."""
    work = folder / WORK_DIR
    pid, fd = pty.fork()

    if pid == 0:
        os.chdir(work)
        env = {name: value for name, value in os.environ.items() if name not in PARENT_SESSION}
        os.execvpe(argv[0], list(argv), env | {"TERM": TERMINAL})

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    screen = pyte.Screen(columns, rows)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    queue = folder / QUEUE_DIR
    written = 0.0

    while not (folder / QUIT_FILE).exists():
        ready, _, _ = select.select([fd], [], [], POLL_SECONDS)

        if ready:
            try:
                data = os.read(fd, READ_BYTES)
            except OSError:
                break

            if not data:
                break

            stream.feed(decoder.decode(data))

        for item in sorted(queue.iterdir()):
            if item.suffix != ".tmp":
                os.write(fd, item.read_bytes())
                item.unlink()

        if time.monotonic() - written > WRITE_SECONDS:
            (folder / SCREEN_FILE).write_text(plain(screen), encoding="utf-8")
            (folder / COLORS_FILE).write_text(colored(screen), encoding="utf-8")
            written = time.monotonic()

    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGTERM)

    (folder / PID_FILE).unlink(missing_ok=True)


def put(folder: Path, data: bytes) -> None:
    """Queue bytes for the session to read as typed input."""
    if running(folder) is None:
        message = f"no session runs in {folder}: start one first"
        raise DriveError(message)

    name = f"{time.time_ns()}"
    (folder / QUEUE_DIR / f"{name}.tmp").write_bytes(data)
    (folder / QUEUE_DIR / f"{name}.tmp").rename(folder / QUEUE_DIR / name)


def screen_of(folder: Path, *, colors: bool = False) -> str:
    """Return the last screen that the session wrote."""
    path = folder / (COLORS_FILE if colors else SCREEN_FILE)

    return path.read_text(encoding="utf-8") if path.exists() else ""


def wait(folder: Path, wanted: re.Pattern[str], timeout: float, settle: float) -> bool:
    """Wait until the screen matches the pattern, then for it to settle.

    Claude Code redraws parts of the screen in ways the emulator does not always follow,
    and the text then comes out garbled. So while nothing matches, the session is asked
    to draw the whole screen again.
    """
    deadline = time.monotonic() + timeout
    redrawn = time.monotonic()

    while time.monotonic() < deadline:
        if wanted.search(screen_of(folder)):
            time.sleep(settle)

            return True

        if time.monotonic() - redrawn > REDRAW_SECONDS:
            put(folder, KEYS["ctrl-l"])
            redrawn = time.monotonic()

        time.sleep(POLL_SECONDS)

    return False


def start(folder: Path, rows: int, columns: int, extra: Sequence[str], timeout: float) -> bool:
    """Start a session in the background, and wait until it is at its prompt."""
    if running(folder) is not None:
        message = f"a session already runs in {folder}: stop it first"
        raise DriveError(message)

    for name in (QUEUE_DIR, WORK_DIR):
        (folder / name).mkdir(parents=True, exist_ok=True)

    for name in (SCREEN_FILE, COLORS_FILE, QUIT_FILE):
        (folder / name).unlink(missing_ok=True)

    argv = ["claude", "--plugin-dir", str(REPOSITORY), "--model", "haiku", *extra]
    pid = os.fork()

    if pid == 0:
        # The server: its own session, so it outlives the shell that started it.
        os.setsid()
        log = os.open(folder / LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.dup2(log, 1)
        os.dup2(log, 2)
        (folder / PID_FILE).write_text(str(os.getpid()), encoding="utf-8")
        serve(folder, rows, columns, argv)
        os._exit(Exit.OK)

    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        screen = screen_of(folder)

        if READY.search(screen) and not TRUST_DIALOG.search(screen):
            time.sleep(1.0)

            return True

        # A folder that Claude Code has not seen: the first choice is "No, exit".
        if TRUST_DIALOG.search(screen) and not TRUST_CHOSEN.search(screen):
            put(folder, KEYS["down"])
        elif TRUST_CHOSEN.search(screen):
            put(folder, KEYS["enter"])

        time.sleep(0.5)

    return False


def stop(folder: Path) -> None:
    """End the session and wait until its server is gone."""
    (folder / QUIT_FILE).touch()
    deadline = time.monotonic() + STOP_SECONDS

    while running(folder) is not None and time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)

    pid = running(folder)

    if pid is not None:
        os.kill(pid, signal.SIGKILL)


def parser() -> argparse.ArgumentParser:
    """Build the command line."""
    top = argparse.ArgumentParser(description=__doc__)
    top.add_argument("--dir", type=Path, required=True, help="a folder for the driver's files")
    commands = top.add_subparsers(dest="command", required=True)
    begin = commands.add_parser(
        Command.START, help="start a session with the mod, in the background"
    )
    begin.add_argument("--rows", type=int, default=46)
    begin.add_argument("--columns", type=int, default=130)
    begin.add_argument("--timeout", type=float, default=90.0)
    begin.add_argument("extra", nargs="*", help="more arguments for claude, after --")
    typed = commands.add_parser(Command.SEND, help="type text into the session, without Enter")
    typed.add_argument("text")
    pressed = commands.add_parser(Command.KEY, help="press one key")
    pressed.add_argument("name", choices=sorted(KEYS))
    held = commands.add_parser(Command.WAIT, help="wait until the screen matches a pattern")
    held.add_argument("--for", dest="pattern", required=True, help="a regular expression")
    held.add_argument("--timeout", type=float, default=30.0)
    held.add_argument("--settle", type=float, default=0.8)
    held.add_argument("--colors", action="store_true", help="print the screen with its colors")
    shown = commands.add_parser(Command.SHOW, help="print the screen")
    shown.add_argument("--colors", action="store_true", help="print the screen with its colors")
    commands.add_parser(Command.STOP, help="end the session")

    return top


def run(args: argparse.Namespace) -> int:
    """Run one command and return its exit code."""
    folder: Path = args.dir
    command = Command(args.command)

    match command:
        case Command.START:
            folder.mkdir(parents=True, exist_ok=True)
            is_ready = start(folder, args.rows, args.columns, args.extra, args.timeout)
            sys.stdout.write(screen_of(folder))

            if not is_ready:
                sys.stderr.write("timed out waiting for the session's prompt\n")

            return Exit.OK if is_ready else Exit.TIMEOUT
        case Command.SEND:
            put(folder, args.text.encode("utf-8"))
        case Command.KEY:
            put(folder, KEYS[args.name])
        case Command.WAIT:
            is_found = wait(folder, re.compile(args.pattern), args.timeout, args.settle)
            sys.stdout.write(screen_of(folder, colors=args.colors))

            if not is_found:
                sys.stderr.write(f"timed out waiting for {args.pattern!r}\n")

            return Exit.OK if is_found else Exit.TIMEOUT
        case Command.SHOW:
            sys.stdout.write(screen_of(folder, colors=args.colors))
        case Command.STOP:
            stop(folder)
        case _:
            assert_never(command)

    return Exit.OK


def main(argv: Sequence[str] | None = None) -> int:
    """Parse the command line and run one command."""
    args = parser().parse_args(argv)

    try:
        return run(args)
    except DriveError as error:
        sys.stderr.write(f"{error}\n")

        return Exit.FAILED


if __name__ == "__main__":
    raise SystemExit(main())
