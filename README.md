# tsv-log-demo

独立仓库：半导体测试 **TSV 日志演示流** + **插单/特殊情况随机事件流**（互不影响）。

源自原 `sym990908/rea` 的 `log-demo` 分支 demo，已瘦身，仅保留 Python 服务。

## 运行

```bash
python main.py
# 或
PORT=10000 LOG_INTERVAL_SEC=1 SPECIAL_INTERVAL_SEC=45 python main.py
```

标准库即可，无第三方依赖。

## 端点

| 路径 | 说明 |
| --- | --- |
| `/` | TSV log 网页（与原先一致） |
| `/stream` | TSV log SSE |
| `/health` | 健康检查 |
| `/special` | 特殊情况调试页（独立页面） |
| `/special/stream` | 特殊情况 SSE（每条 `data:` 后为一行 JSON） |
| `/special/latest?limit=20` | 最近 N 条特殊情况 JSON 数组 |

TSV 行仍只走 stdout；特殊事件打印到 **stderr**（前缀 `SPECIAL`），不会混进 `/stream`。

## 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PORT` | `10000` | 监听端口（Render 会注入） |
| `LOG_INTERVAL_SEC` | `1` | 正常 TSV 行间隔 |
| `ERROR_INTERVAL_SEC` | `600` | 错误行间隔 |
| `SPECIAL_INTERVAL_SEC` | `45` | 特殊情况间隔 |
| `SPECIAL_ENABLED` | `true` | 设为 `false` 关闭特殊事件线程 |

## 给其它程序读特殊情况

```bash
curl -N https://<host>/special/stream
curl https://<host>/special/latest
```
