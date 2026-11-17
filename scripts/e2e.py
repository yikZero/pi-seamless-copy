#!/usr/bin/env python3
"""End-to-end check: drive a real Pi in a pty, drag-select wrapped text, read the copy.

Usage: uv run --with pyte==0.8.2 python scripts/e2e.py [--baseline] [--with-user-extensions]

Pi replays a fixture session (no model call), the script drags the mouse across a wrapped
paragraph, and decodes the OSC 52 payload Pi emits for the copy (PI_CLIPBOARD_OSC52=1). Pi also
writes the native clipboard, so the script restores its previous contents afterwards.
"""

import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte

COLS, ROWS = 72, 40
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CJK = (
    "第二段：下面这句稍长一点，方便检查自动换行。OneKey 钱包支持桌面、手机、网页和浏览器扩展，"
    "复制时如果中间被拆成两行，粘贴回去应该仍然连在一起，不该多出奇怪的空格或丢失句号。"
)
ENGLISH = "The quick brown fox jumps over the lazy dog, then keeps running across a line that is far too long for this narrow terminal."
BULLET = "a bullet item whose text is long enough to wrap onto a second row in this terminal"
COMMAND = "yarn agent:check --profile pr --verbose --report node_modules/.cache/agent-checks/report.json"
ANSWER = f"{CJK}\n\n{ENGLISH}\n\n- {BULLET}\n- short item\n\n```sh\n{COMMAND}\n```\n\nEND-MARKER"


def write_session(directory: str) -> str:
    path = os.path.join(directory, "session.jsonl")
    now = int(time.time() * 1000)
    iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    entries = [
        {"type": "session", "version": 3, "id": "e2e00000-0000-4000-8000-000000000000", "timestamp": iso, "cwd": directory},
        {"type": "message", "id": "u0000001", "parentId": None, "timestamp": iso,
         "message": {"role": "user", "content": "copy test", "timestamp": now}},
        {"type": "message", "id": "a0000001", "parentId": "u0000001", "timestamp": iso,
         "message": {"role": "assistant", "content": [{"type": "text", "text": ANSWER}], "api": "anthropic-messages",
                     "provider": "anthropic", "model": "claude-sonnet-4-5",
                     "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                               "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                     "stopReason": "stop", "timestamp": now}},
    ]
    with open(path, "w") as file:
        for entry in entries:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path


def cells(screen: pyte.Screen, row: int) -> list[tuple[int, str]]:
    """(column, char) for each non-placeholder cell of a row."""
    line = screen.buffer[row]
    return [(x, line[x].data) for x in range(screen.columns) if line[x].data != ""]


def row_text(screen: pyte.Screen, row: int) -> str:
    return "".join(char for _, char in cells(screen, row))


def find_row(screen: pyte.Screen, needle: str, start: int = 0) -> int:
    for row in range(start, screen.lines):
        if needle in row_text(screen, row):
            return row
    raise RuntimeError(f"{needle!r} not on screen:\n" + "\n".join(row_text(screen, r) for r in range(screen.lines)))


def column_of(screen: pyte.Screen, row: int, needle: str) -> int:
    chars = cells(screen, row)
    text = "".join(char for _, char in chars)
    return chars[text.index(needle)][0]


def last_column(screen: pyte.Screen, row: int) -> int:
    chars = [(x, c) for x, c in cells(screen, row) if c.strip()]
    return chars[-1][0]


class Pi:
    def __init__(self, args: list[str], cwd: str):
        self.raw = b""
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
            os.chdir(cwd)
            env = dict(os.environ, PI_CLIPBOARD_OSC52="1", TERM="xterm-256color")
            os.execvpe("pi", ["pi", *args], env)

    def pump(self, seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                self.raw += data
                self.stream.feed(data)

    def send(self, data: bytes) -> None:
        os.write(self.fd, data)

    def drag(self, start: tuple[int, int], end: tuple[int, int]) -> None:
        (x0, y0), (x1, y1) = start, end
        self.send(f"\x1b[<0;{x0 + 1};{y0 + 1}M".encode())
        self.pump(0.1)
        self.send(f"\x1b[<32;{x1 + 1};{y1 + 1}M".encode())
        self.pump(0.1)
        self.send(f"\x1b[<0;{x1 + 1};{y1 + 1}m".encode())

    def last_copy(self) -> str | None:
        payloads = re.findall(rb"\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)", self.raw)
        return base64.b64decode(payloads[-1]).decode() if payloads else None

    def close(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                return
            for _ in range(20):
                if os.waitpid(self.pid, os.WNOHANG) != (0, 0):
                    return
                self.pump(0.1)


def select_and_copy(pi: Pi, first: str, last: str) -> str | None:
    screen = pi.screen
    top = find_row(screen, first)
    bottom = find_row(screen, last, top)
    start = (column_of(screen, top, first), top)
    end = (last_column(screen, bottom), bottom)
    before = pi.raw.count(b"\x1b]52;c;")
    pi.drag(start, end)
    for _ in range(40):
        pi.pump(0.1)
        if pi.raw.count(b"\x1b]52;c;") > before:
            break
    return pi.last_copy() if pi.raw.count(b"\x1b]52;c;") > before else None


def main() -> int:
    baseline = "--baseline" in sys.argv
    args = [] if "--with-user-extensions" in sys.argv else ["-ne"]
    if not baseline:
        args += ["-e", ROOT]
    saved_clipboard = subprocess.run(["pbpaste"], capture_output=True).stdout if sys.platform == "darwin" else None
    cases = [
        ("CJK paragraph", "第二段", "丢失句号。", CJK),
        ("English paragraph", "The quick", "terminal.", ENGLISH),
        ("Bullet", "- a bullet", "this terminal", f"- {BULLET}"),
        ("Code block", "yarn agent", "report.json", COMMAND),
        ("Several blocks", "第二段", "terminal.", f"{CJK}\n\n{ENGLISH}"),
    ]
    failures = 0
    with tempfile.TemporaryDirectory() as directory:
        session = write_session(directory)
        pi = Pi([*args, "--session", session, "--tui-mode", "fullscreen", "--offline"], directory)
        try:
            pi.pump(8)
            find_row(pi.screen, "END-MARKER")
            for name, first, last, expected in cases:
                copied = select_and_copy(pi, first, last)
                ok = copied is not None and copied.strip() == expected
                failures += 0 if ok else 1
                print(f"{'PASS' if ok else 'FAIL'} {name}")
                if not ok:
                    print(f"  expected: {expected!r}\n  copied:   {copied!r}")
                pi.send(b"\x1b")  # clear the selection
                pi.pump(0.3)
        finally:
            pi.close()
            if saved_clipboard is not None:
                subprocess.run(["pbcopy"], input=saved_clipboard)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
