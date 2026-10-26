#!/usr/bin/env python3
"""Render web service that emits sample-shaped TSV test logs on stdout."""

from __future__ import annotations

import json
import os
import random
import sys
import threading
import time
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
    raw = os.environ.get("LOG_INTERVAL_SEC", "1")
    try:
        value = float(raw)
    except ValueError:
        return 1.0
    if value < 0:
        return 1.0
    return value


def _uid() -> str:
    if random.random() < 0.65:
        return "0000000000000000"
    return f"{random.getrandbits(64):016x}"


def _temperature() -> str:
    tenths = random.randint(450, 550)
    return f"{tenths // 10}.{tenths % 10}"


def _fail_patterns() -> str:
    if random.random() < 0.88:
        return "[]"
    chosen = random.sample(["e5", "e41", "e78", "p1", "p12", "p16"], k=random.randint(1, 3))
    return json.dumps(chosen, separators=(",", ":"))


def _pattern_times() -> str:
    values = {key: random.randint(0, 16) for key in PATTERN_KEYS}
    return json.dumps(values, separators=(",", ":"), sort_keys=True)


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
        status = random.choice(("WGLP-OK", "WGLP-NG", "FT-OK"))
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
            "0" if random.random() < 0.92 else "1",
            "0" if random.random() < 0.96 else "1",
            str(random.randint(90, 140)),
            "0" if random.random() < 0.8 else str(random.randint(1, 5)),
            "normal" if random.random() < 0.9 else "high",
            _temperature(),
            "B15",
            "0",
            _fail_patterns(),
            _pattern_times(),
            "{}",
        ]
        return "\t".join(fields)


class HealthHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/health"):
            body = b"OK\n"
            status = 200
        else:
            body = b"not found\n"
            status = 404
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        return


class HealthServer(ThreadingHTTPServer):
    allow_reuse_address = True


def emit_forever(emitter: LogEmitter, interval: float) -> None:
    print("\t".join(COLUMNS), flush=True)
    while True:
        time.sleep(interval)
        print(emitter.line(), flush=True)


def main() -> None:
    port = listen_port()
    interval = interval_seconds()
    worker = threading.Thread(
        target=emit_forever,
        args=(LogEmitter(), interval),
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
