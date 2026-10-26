#!/usr/bin/env python3
"""Render web service that emits sample-shaped TSV test logs on stdout."""

from __future__ import annotations

import json
import os
import queue
import random
import socket
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TZ_CN = timezone(timedelta(hours=8))

COLUMNS = (
    "id",
    "start_time",
    "end_time",
    "execution_no",
    "command_no",
    "track_card_no",
    "sn_code",
    "uid_rk0",
    "uid_rk1",
    "bin_level",
    "bincode",
    "machine_code",
    "equipment_code",
    "channel",
    "port_index",
    "bootfail",
    "abnReboot",
    "pass_count",
    "fail_count",
    "temperature_type",
    "temperature",
    "platform",
    "chip_index",
    "fail_patterns",
    "pattern_times",
    "extra",
)

PATTERN_KEYS = (
    [f"a{i}" for i in range(1, 4)]
    + ["c2", "c3"]
    + [f"e{i}" for i in range(1, 81)]
    + [f"p{i}" for i in range(1, 22)]
    + ["pa", "pb", "s1", "s2"]
)


def listen_port() -> int:
    raw = os.environ.get("PORT", "10000")
    try:
        port = int(raw)
    except ValueError as exc:
        raise SystemExit(f"invalid PORT: {raw}") from exc
    if not 0 < port < 65536:
        raise SystemExit(f"invalid PORT: {raw}")
    return port


def interval_seconds() -> float:
    return _non_negative_env("LOG_INTERVAL_SEC", 1.0)


def error_interval_seconds() -> float:
    return _non_negative_env("ERROR_INTERVAL_SEC", 600.0)


def _non_negative_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if value < 0:
        return default
    return value


def jittered_interval(base: float) -> float:
    """Return base with ±20% jitter. Zero stays zero."""
    if base == 0:
        return 0.0
    return base * random.uniform(0.8, 1.2)


def _uid() -> str:
    if random.random() < 0.65:
        return "0000000000000000"
    return f"{random.getrandbits(64):016x}"


def _tenths(low: int, high: int) -> str:
    tenths = random.randint(low, high)
    return f"{tenths // 10}.{tenths % 10}"


def _pattern_times(hot_keys: list[str] | None = None) -> str:
    values = {key: random.randint(0, 12) for key in PATTERN_KEYS}
    for key in hot_keys or ():
        if key in values:
            values[key] = random.randint(40, 180)
    return json.dumps(values, separators=(",", ":"), sort_keys=True)


def _error_patterns() -> str:
    chosen = random.sample(["e5", "e41", "e65", "e78", "p1", "p12", "p16"], k=random.randint(2, 4))
    return json.dumps(chosen, separators=(",", ":"))


def _iso(moment: datetime) -> str:
    return moment.replace(microsecond=0).isoformat()


class LogEmitter:
    """Monotonic ids and batches that share one execution, like the sample."""

    def __init__(self) -> None:
        self._next_id = 1
        self._remaining = 0
        self._batch: dict[str, str] = {}
        self._ports: list[int] = []
        self._port_at = 0

    def _roll_batch(self) -> None:
        now = datetime.now(TZ_CN)
        lot = f"FA{now.strftime('%y%m%d')}{random.randint(0, 999):03d}"
        test = f"TEST{random.randint(1, 9):03d}"
        status = random.choice(("WGLP-OK", "FT-OK"))
        count = random.choice((100, 500, 1000, 2000))
        track = f"{lot}_{test}_{status}_{count}"
        execution = f"EXEC-{track}-{test}"
        millis = int(now.timestamp() * 1000)
        machine = f"B15AT-{random.randint(1, 12):03d}"
        self._batch = {
            "track": track,
            "execution": execution,
            "command": f"CMD-{execution}-{millis}",
            "machine": machine,
            "bin_level": random.choice(("TO@P12", "TO@P12", "TO@P12", "TO@P08", "TO@P16")),
            "bincode": random.choice(("05", "05", "05", "01", "06")),
        }
        width = random.randint(3, 8)
        self._ports = list(range(width))
        self._port_at = 0
        self._remaining = width

    def line(self) -> str:
        if self._remaining <= 0:
            self._roll_batch()
        port = self._ports[self._port_at]
        self._port_at += 1
        self._remaining -= 1

        start = datetime.now(TZ_CN)
        end = start if random.random() < 0.7 else start + timedelta(seconds=1)
        row_id = self._next_id
        self._next_id += 1
        machine = self._batch["machine"]
        fields = [
            str(row_id),
            _iso(start),
            _iso(end),
            self._batch["execution"],
            self._batch["command"],
            self._batch["track"],
            f"ch3dut{port}",
            _uid(),
            _uid(),
            self._batch["bin_level"],
            self._batch["bincode"],
            machine,
            machine,
            "4",
            str(port + 1),
            "0",
            "0",
            str(random.randint(100, 130)),
            "0",
            "normal",
            _tenths(450, 550),
            "B15",
            "0",
            "[]",
            _pattern_times(),
            "{}",
        ]
        return "\t".join(fields)

    def error_line(self) -> tuple[str, str]:
        """One failure row plus a non-TSV marker. The row keeps the same columns."""
        if self._remaining <= 0:
            self._roll_batch()
        port = self._ports[self._port_at]
        self._port_at += 1
        self._remaining -= 1

        start = datetime.now(TZ_CN)
        end = start + timedelta(seconds=random.choice((0, 1)))
        row_id = self._next_id
        self._next_id += 1
        machine = self._batch["machine"]
        execution, command, track = _ng_identity(start)
        patterns = _error_patterns()
        hot_keys = json.loads(patterns)
        bootfail, abn_reboot = _boot_flags()
        fail_count = random.randint(12, 40)
        temperature_type = "abnormal" if random.random() < 0.75 else "high"
        sn_code = f"ch3dut{port}"
        fields = [
            str(row_id),
            _iso(start),
            _iso(end),
            execution,
            command,
            track,
            sn_code,
            _uid(),
            _uid(),
            "TO@F01",
            random.choice(("08", "90", "99")),
            machine,
            machine,
            "4",
            str(port + 1),
            bootfail,
            abn_reboot,
            str(random.randint(10, 80)),
            str(fail_count),
            temperature_type,
            _tenths(620, 750),
            "B15",
            "0",
            patterns,
            _pattern_times(hot_keys),
            "{}",
        ]
        marker = (
            f"ERROR: id={row_id} sn={sn_code} fail_count={fail_count} "
            f"bootfail={bootfail} abnReboot={abn_reboot} "
            f"temperature_type={temperature_type} fail_patterns={patterns}"
        )
        return marker, "\t".join(fields)


def _boot_flags() -> tuple[str, str]:
    """At least one of bootfail / abnReboot is 1."""
    roll = random.randrange(3)
    if roll == 0:
        return "1", "0"
    if roll == 1:
        return "0", "1"
    return "1", "1"


def _ng_identity(now: datetime) -> tuple[str, str, str]:
    lot = f"FA{now.strftime('%y%m%d')}{random.randint(0, 999):03d}"
    test = f"TEST{random.randint(1, 9):03d}"
    track = f"{lot}_{test}_WGLP-NG_{random.choice((100, 500, 1000))}"
    execution = f"EXEC-{track}-{test}"
    command = f"CMD-{execution}-{int(now.timestamp() * 1000)}"
    return execution, command, track


HEADER_LINE = "\t".join(COLUMNS)
PAGE_LINE_CAP = 500
KEEPALIVE_SEC = 15.0

PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TSV log</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: #0e1116;
    color: #d7e0ea;
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    tab-size: 2;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid #243041;
    background: #121820;
  }
  h1 { margin: 0; font-size: 14px; font-weight: 600; }
  #status { color: #8b9cb3; }
  #status.live { color: #7ee0a8; }
  #status.down { color: #ff8b80; }
  #columns {
    margin: 0;
    padding: 8px 16px;
    color: #8b9cb3;
    white-space: pre;
    overflow-x: auto;
    border-bottom: 1px solid #243041;
  }
  #log { flex: 1; overflow: auto; padding: 8px 16px 20px; }
  #log div { white-space: pre; }
  #log div.err { color: #ffb4a8; }
</style>
</head>
<body>
<header>
  <h1>TSV log</h1>
  <div id="status">connecting</div>
</header>
<pre id="columns"></pre>
<div id="log" role="log" aria-live="polite"></div>
<script>
const LINE_CAP = %%LINE_CAP%%;
const statusEl = document.getElementById("status");
const columnsEl = document.getElementById("columns");
const logEl = document.getElementById("log");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function append(text) {
  const row = document.createElement("div");
  row.textContent = text;
  if (text.startsWith("ERROR:")) row.className = "err";
  logEl.appendChild(row);
  while (logEl.childElementCount > LINE_CAP) {
    logEl.removeChild(logEl.firstChild);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

const source = new EventSource("/stream");
source.onopen = () => setStatus("live", "live");
source.addEventListener("reset", () => {
  logEl.replaceChildren();
  columnsEl.textContent = "";
  setStatus("live", "live");
});
source.onmessage = (event) => {
  const text = event.data;
  if (text.startsWith("id\\t")) {
    columnsEl.textContent = text;
    return;
  }
  append(text);
};
source.onerror = () => setStatus("reconnecting", "down");
</script>
</body>
</html>
"""


def page_body() -> bytes:
    return PAGE_HTML.replace("%%LINE_CAP%%", str(PAGE_LINE_CAP)).encode("utf-8")


class LogHub:
    """One emitter, stdout, and a bounded fan-out to SSE clients."""

    def __init__(self, maxlen: int = PAGE_LINE_CAP) -> None:
        self._lock = threading.Lock()
        self._ring: deque[str] = deque(maxlen=maxlen)
        self._clients: list[queue.Queue[str]] = []

    def publish(self, line: str) -> None:
        with self._lock:
            self._ring.append(line)
            clients = list(self._clients)
        print(line, flush=True)
        for client in clients:
            _offer(client, line)

    def subscribe(self) -> tuple[list[str], queue.Queue[str]]:
        client: queue.Queue[str] = queue.Queue(maxsize=PAGE_LINE_CAP)
        with self._lock:
            snapshot = list(self._ring)
            self._clients.append(client)
        return snapshot, client

    def unsubscribe(self, client: queue.Queue[str]) -> None:
        with self._lock:
            try:
                self._clients.remove(client)
            except ValueError:
                return


def _offer(client: queue.Queue[str], line: str) -> None:
    try:
        client.put_nowait(line)
        return
    except queue.Full:
        pass
    try:
        client.get_nowait()
    except queue.Empty:
        pass
    try:
        client.put_nowait(line)
    except queue.Full:
        return


def _sse_data(line: str) -> str:
    safe = line.replace("\r", " ").replace("\n", " ")
    return f"data: {safe}\n\n"


class HealthHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    hub: LogHub | None = None

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_bytes(200, b"OK\n", "text/plain; charset=utf-8")
        elif path == "/":
            self._send_bytes(200, page_body(), "text/html; charset=utf-8")
        elif path == "/stream":
            self._stream()
        else:
            self._send_bytes(404, b"not found\n", "text/plain; charset=utf-8")

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _stream(self) -> None:
        hub = self.hub
        if hub is None:
            self._send_bytes(503, b"not ready\n", "text/plain; charset=utf-8")
            return
        snapshot, client = hub.subscribe()
        try:
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            self._write_chunk(b"event: reset\ndata: ok\n\n")
            for line in snapshot:
                self._write_chunk(_sse_data(line).encode("utf-8"))
            while True:
                try:
                    line = client.get(timeout=KEEPALIVE_SEC)
                except queue.Empty:
                    self._write_chunk(b": keepalive\n\n")
                    continue
                self._write_chunk(_sse_data(line).encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except OSError:
            return
        finally:
            hub.unsubscribe(client)

    def _write_chunk(self, payload: bytes) -> None:
        frame = f"{len(payload):X}\r\n".encode("ascii") + payload + b"\r\n"
        self.wfile.write(frame)
        self.wfile.flush()

    def log_message(self, fmt: str, *args: object) -> None:
        return


class HealthServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def emit_forever(hub: LogHub, emitter: LogEmitter, interval: float, error_every: float) -> None:
    hub.publish(HEADER_LINE)
    next_error_at = time.monotonic() + jittered_interval(error_every)
    while True:
        time.sleep(interval)
        now = time.monotonic()
        if now >= next_error_at:
            marker, row = emitter.error_line()
            hub.publish(marker)
            hub.publish(row)
            next_error_at = now + jittered_interval(error_every)
        else:
            hub.publish(emitter.line())


def main() -> None:
    port = listen_port()
    interval = interval_seconds()
    error_every = error_interval_seconds()
    hub = LogHub()
    HealthHandler.hub = hub
    worker = threading.Thread(
        target=emit_forever,
        args=(hub, LogEmitter(), interval, error_every),
        name="tsv-log",
        daemon=True,
    )
    worker.start()
    server = HealthServer(("0.0.0.0", port), HealthHandler)
    print(f"listening on 0.0.0.0:{port}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
