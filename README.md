# TSV log demo

Minimal Render web service. A background thread prints random tab-separated test-log rows to stdout about once a second. HTTP stays up for health checks.

## Run

```bash
python main.py
```

Listens on `0.0.0.0:$PORT` (default `10000`).

- `GET /` and `GET /health` return `200` with body `OK`.
- At startup the process prints the TSV header once, then data rows forever. Each line is flushed immediately.
- Steady rows look successful (`fail_count` 0, empty `fail_patterns`, `temperature_type` `normal`).
- About every `ERROR_INTERVAL_SEC` seconds (default 600, jittered by ±20%) the process prints one `ERROR: ...` marker on stdout, then one failure TSV row with the same columns. That row raises `fail_count`, sets a non-empty `fail_patterns`, sets `bootfail` and/or `abnReboot` to 1, uses `temperature_type` `abnormal` or `high`, and elevates the matching `pattern_times` keys.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `10000` | HTTP port. Render sets this. |
| `LOG_INTERVAL_SEC` | `1` | Seconds between log lines. |
| `ERROR_INTERVAL_SEC` | `600` | Base gap between failure rows. Each gap is this value ±20%. |

## Render

- **buildCommand:** `pip install -r requirements.txt` (or `true`; there are no packages)
- **startCommand:** `python main.py`

Python 3 standard library only (`http.server` and `threading`).
