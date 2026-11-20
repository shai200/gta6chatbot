# Leonida Intel — GTA VI companion chatbot

A full-screen, mobile-friendly chatbot for GTA VI players. Answers stream token by token through [BetterProxy](https://betterproxy.ai), and every request's cache behaviour is logged and monitored in the background.

Unofficial fan-made project. Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.

## Run

Requires Node 21.7+ (no dependencies to install).

```bash
cp .env.example .env   # then put your BetterProxy key in BETTERPROXY_API_KEY
npm start
```

- Chat: http://localhost:3000
- Cache monitor: http://localhost:3000/monitor

## Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `BETTERPROXY_API_KEY` | – | Your `llms_live_…` key. Stays on the server, never sent to the browser. |
| `BETTERPROXY_BASE_URL` | `https://api.betterproxy.ai/v1` | OpenAI-compatible base URL. |
| `BETTERPROXY_MODEL` | `gpt-4o-mini` | Model used for answers. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |
| `MONITOR_TOKEN` | – | If set, the monitor requires `/monitor?token=…`. |
| `CACHE_LOG_FILE` | `logs/cache.jsonl` | Where cache records are appended. |

## Cache logging and monitoring

For every chat request the server reads BetterProxy's response headers (`X-Cache-Hit`, `X-Cache-Status`, `X-Latency-Ms`, `X-Tokens-Charged`, `X-Credits-Remaining`, `X-Billing-Mode`, `X-RTK-Saved-Tokens`) and measures its own time-to-first-token and total time. Each record is:

- printed to the server console as a `[cache] HIT|MISS …` line,
- appended to `logs/cache.jsonl` (one JSON object per line; counters are rebuilt from it on restart),
- aggregated at `GET /api/cache/stats` (hit rate, hit vs. miss latency, tokens charged, credits left) and shown live at `/monitor`.

Chat users never see any of this; it runs server-side.

## Layout

- `server.js` — static files, `/api/chat` streaming proxy, cache recorder
- `public/` — chat UI (`index.html`, `styles.css`, `app.js`) and `monitor.html`
