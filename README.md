# TSV log demo

Minimal Render web service. A background thread prints random tab-separated test-log rows to stdout about once a second. HTTP stays up for health checks.

## Run

```bash
python main.py
```

Listens on `0.0.0.0:$PORT` (default `10000`).

- `GET /` and `GET /health` return `200` with body `OK`.
- At startup the process prints the TSV header once, then data rows forever. Each line is flushed immediately.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `10000` | HTTP port. Render sets this. |
| `LOG_INTERVAL_SEC` | `1` | Seconds between log lines. |

## Render

- **buildCommand:** `pip install -r requirements.txt` (or `true`; there are no packages)
- **startCommand:** `python main.py`

Python 3 standard library only (`http.server` and `threading`).
