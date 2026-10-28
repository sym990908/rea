#!/usr/bin/env python3
"""Render web service: TSV test logs + independent special-case (插单) events."""

from __future__ import annotations

import json
import os
import queue
import random
import socket
import string
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

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

BASE_CONSTRAINTS = (
    "T-02/CH-03 blocked: contact resistance drift",
    "T-03/CH-07 blocked: fixture aging",
    "T-04 intermittent: no long lots",
)

PRODUCTS = (
    "DDR4-3200",
    "DDR4-2666",
    "DDR4-2400",
    "LPDDR4",
    "LPDDR5",
)

FIXTURES = ("Probe-A", "Probe-B", "Probe-C")
MACHINES = [f"T-{i:02d}" for i in range(1, 13)]


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


def special_interval_seconds() -> float:
    return _non_negative_env("SPECIAL_INTERVAL_SEC", 45.0)


def special_enabled() -> bool:
    raw = os.environ.get("SPECIAL_ENABLED", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


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
SPECIAL_KEEP = 50

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

SPECIAL_PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Special cases</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 16px;
    background: #0e1116; color: #d7e0ea;
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  h1 { font-size: 14px; }
  #status { color: #8b9cb3; margin-bottom: 12px; }
  #status.live { color: #7ee0a8; }
  pre {
    white-space: pre-wrap; word-break: break-word;
    border: 1px solid #243041; padding: 10px; margin: 0 0 10px;
    background: #121820;
  }
</style>
</head>
<body>
<h1>插单 / 特殊情况（独立于 TSV log）</h1>
<div id="status">connecting</div>
<div id="list"></div>
<script>
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const source = new EventSource("/special/stream");
source.onopen = () => { statusEl.textContent = "live"; statusEl.className = "live"; };
source.onmessage = (event) => {
  const pre = document.createElement("pre");
  try {
    pre.textContent = JSON.stringify(JSON.parse(event.data), null, 2);
  } catch {
    pre.textContent = event.data;
  }
  listEl.prepend(pre);
  while (listEl.childElementCount > 30) listEl.removeChild(listEl.lastChild);
};
source.onerror = () => { statusEl.textContent = "reconnecting"; statusEl.className = ""; };
</script>
</body>
</html>
"""


def page_body() -> bytes:
    return PAGE_HTML.replace("%%LINE_CAP%%", str(PAGE_LINE_CAP)).encode("utf-8")


def special_page_body() -> bytes:
    return SPECIAL_PAGE_HTML.encode("utf-8")


class LogHub:
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


class SpecialHub:
    """Independent fan-out for special-case JSON events. Never touches LogHub."""

    def __init__(self, maxlen: int = SPECIAL_KEEP) -> None:
        self._lock = threading.Lock()
        self._ring: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._clients: list[queue.Queue[str]] = []
        self._seq = 0

    def publish(self, event: dict[str, Any]) -> None:
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._ring.append(event)
            clients = list(self._clients)
        # Keep special events off the TSV stdout channel; mirror to stderr for operators.
        print(f"SPECIAL {payload}", file=sys.stderr, flush=True)
        for client in clients:
            _offer(client, payload)

    def latest(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self._ring)
        if limit < 1:
            return []
        return items[-limit:]

    def subscribe(self) -> tuple[list[str], queue.Queue[str]]:
        client: queue.Queue[str] = queue.Queue(maxsize=SPECIAL_KEEP)
        with self._lock:
            snapshot = [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in self._ring]
            self._clients.append(client)
        return snapshot, client

    def unsubscribe(self, client: queue.Queue[str]) -> None:
        with self._lock:
            try:
                self._clients.remove(client)
            except ValueError:
                return

    def next_id(self) -> str:
        with self._lock:
            self._seq += 1
            seq = self._seq
        now = datetime.now(TZ_CN)
        suffix = random.choice(string.ascii_uppercase)
        return f"WAVE-{now.strftime('%Y%m%d-%H%M%S')}-{seq:03d}{suffix}"


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


def _due_soon(hours_ahead: float = 8.0) -> str:
    now = datetime.now(TZ_CN)
    due = now + timedelta(minutes=random.randint(60, int(hours_ahead * 60)))
    return due.strftime("%H:%M")


def generate_special_event(event_id: str) -> dict[str, Any]:
    """Random demo special-case for scheduling stress tests."""
    kind = random.choice(
        (
            "rush_insert",
            "fixture_conflict",
            "exec_fault_reflow",
            "scheme_stretch",
            "channel_block",
            "retest_reject",
            "customer_machine_lock",
            "dual_machine_down",
        )
    )
    product = random.choice(PRODUCTS)
    fixture = random.choice(FIXTURES)
    qty = random.choice((240, 320, 400, 600, 800, 960, 1200))
    due = _due_soon()
    machine = random.choice(MACHINES)
    lot_n = random.randint(1, 99)
    constraints = list(random.sample(BASE_CONSTRAINTS, k=random.randint(1, 3)))

    if kind == "rush_insert":
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "工单排产",
            "lot": f"Lot-Rush-{lot_n}",
            "product": product,
            "qty": qty,
            "due": due,
            "priority": "插单",
            "fixture": fixture,
            "machine_hint": machine,
            "constraints": constraints,
            "summary": f"紧急插单 Lot-Rush-{lot_n}：{product} × {qty}，交期 {due}，制具 {fixture}",
            "expect": "评估可排与否、机台窗口、交期灯；写入 MES 前须人确认",
        }
    if kind == "fixture_conflict":
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "订单创建",
            "lot": f"Lot-Rush-{lot_n}",
            "product": product,
            "qty": qty,
            "due": due,
            "priority": "插单",
            "fixture": "Probe-A",
            "machine_hint": machine,
            "constraints": constraints + ["Probe-A contended with Lot-B16/Lot-A18"],
            "summary": f"同制具二次插单冲突：Lot-Rush-{lot_n} 与在制批争用 Probe-A，交期 {due}",
            "expect": "裁决优先级并给出合并排产后的交期风险",
        }
    if kind == "exec_fault_reflow":
        from_m = random.choice(MACHINES)
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "工单执行",
            "lot": f"Lot-Rush-{lot_n}",
            "product": product,
            "qty": qty,
            "due": due,
            "priority": "插单",
            "fixture": fixture,
            "machine_hint": from_m,
            "constraints": constraints + [f"{from_m} port timeout mid-lot", "remain ~45%"],
            "summary": f"执行回流：{from_m} 跑 Lot-Rush-{lot_n} 中端口超时，约 45% 未完，需热迁保交期 {due}",
            "expect": "给出迁移机台与窗口；标交期绿黄红",
        }
    if kind == "scheme_stretch":
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "方案审核",
            "lot": f"Lot-C{lot_n}",
            "product": product,
            "qty": qty,
            "due": due,
            "priority": "正常",
            "fixture": fixture,
            "machine_hint": machine,
            "constraints": constraints + ["estimated duration +35%"],
            "summary": f"方案变更：Lot-C{lot_n} 工时 +35%，原窗口可能顶破交期 {due}",
            "expect": "重算窗口或拆批；协调制具占用",
        }
    if kind == "channel_block":
        ch = random.choice(("CH-03", "CH-07", "CH-02"))
        m = random.choice(("T-02", "T-03", "T-05"))
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "工单排产",
            "lot": f"Lot-B{lot_n}",
            "product": product,
            "qty": qty,
            "due": due,
            "priority": "紧急",
            "fixture": fixture,
            "machine_hint": m,
            "constraints": constraints + [f"{m}/{ch} stopped"],
            "summary": f"通道停排：{m}/{ch} 不可用，在制批需迁出，交期 {due}",
            "expect": "输出不可用产能快照与迁移目标机台",
        }
    if kind == "retest_reject":
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "测报审核",
            "lot": f"Lot-D{lot_n}",
            "product": product,
            "qty": max(120, qty // 3),
            "due": due,
            "priority": "紧急",
            "fixture": fixture,
            "machine_hint": "T-04",
            "constraints": constraints + ["30% retest", "T-04 short lots only"],
            "summary": f"测报驳回：Lot-D{lot_n} 需约 30% 返工复测，交期仍 {due}",
            "expect": "挤入短窗；若无法保交期标红并需业务决策",
        }
    if kind == "customer_machine_lock":
        lock = random.choice(MACHINES)
        return {
            "id": event_id,
            "ts": _iso(datetime.now(TZ_CN)),
            "type": kind,
            "flowchart_node": "订单创建",
            "lot": f"Lot-Rush-{lot_n}",
            "product": product,
            "qty": qty,
            "due": due,
            "priority": "插单",
            "fixture": fixture,
            "machine_hint": lock,
            "constraints": constraints + [f"customer locks machine {lock}"],
            "summary": f"客户指定机台：Lot-Rush-{lot_n} 只能上 {lock}，交期 {due}",
            "expect": "能否接受指定；否则给替代机台与话术要点",
        }
    # dual_machine_down
    a, b = random.sample(MACHINES, 2)
    return {
        "id": event_id,
        "ts": _iso(datetime.now(TZ_CN)),
        "type": kind,
        "flowchart_node": "工单执行",
        "lot": f"Lot-A{lot_n}",
        "product": product,
        "qty": qty,
        "due": due,
        "priority": "紧急",
        "fixture": fixture,
        "machine_hint": f"{a},{b}",
        "constraints": constraints + [f"{a} down", f"{b} channel fault"],
        "summary": f"双机台故障：{a} 与 {b} 同时不可用，多批需并行迁出",
        "expect": "合并迁移清单；标出最先可能破交期的批次",
    }


class HealthHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    hub: LogHub | None = None
    special_hub: SpecialHub | None = None

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_bytes(200, b"OK\n", "text/plain; charset=utf-8")
        elif path == "/":
            self._send_bytes(200, page_body(), "text/html; charset=utf-8")
        elif path == "/stream":
            self._stream_log()
        elif path == "/special":
            self._send_bytes(200, special_page_body(), "text/html; charset=utf-8")
        elif path == "/special/latest":
            self._special_latest()
        elif path == "/special/stream":
            self._stream_special()
        else:
            self._send_bytes(404, b"not found\n", "text/plain; charset=utf-8")

    def _special_latest(self) -> None:
        hub = self.special_hub
        if hub is None:
            self._send_bytes(503, b'{"error":"not ready"}\n', "application/json; charset=utf-8")
            return
        limit = 20
        if "?" in self.path:
            query = self.path.split("?", 1)[1]
            for part in query.split("&"):
                if part.startswith("limit="):
                    try:
                        limit = max(1, min(100, int(part.split("=", 1)[1])))
                    except ValueError:
                        limit = 20
        body = json.dumps(hub.latest(limit), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        self._send_bytes(200, body, "application/json; charset=utf-8")

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _stream_log(self) -> None:
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
            self.send_header("Access-Control-Allow-Origin", "*")
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
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            return
        finally:
            hub.unsubscribe(client)

    def _stream_special(self) -> None:
        hub = self.special_hub
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
            self.send_header("Access-Control-Allow-Origin", "*")
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
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
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


def emit_special_forever(hub: SpecialHub, interval: float) -> None:
    # First event soon so demos are not empty.
    time.sleep(min(3.0, max(0.5, interval * 0.1)))
    while True:
        event = generate_special_event(hub.next_id())
        hub.publish(event)
        time.sleep(jittered_interval(interval) if interval > 0 else 45.0)


def main() -> None:
    port = listen_port()
    interval = interval_seconds()
    error_every = error_interval_seconds()
    hub = LogHub()
    special = SpecialHub()
    HealthHandler.hub = hub
    HealthHandler.special_hub = special
    threading.Thread(
        target=emit_forever,
        args=(hub, LogEmitter(), interval, error_every),
        name="tsv-log",
        daemon=True,
    ).start()
    if special_enabled():
        threading.Thread(
            target=emit_special_forever,
            args=(special, special_interval_seconds()),
            name="special-cases",
            daemon=True,
        ).start()
    server = HealthServer(("0.0.0.0", port), HealthHandler)
    print(f"listening on 0.0.0.0:{port}", file=sys.stderr, flush=True)
    print(
        "endpoints: / /stream /health /special /special/stream /special/latest",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
