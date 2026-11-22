# Leonida Intel — GTA VI companion chatbot

A full-screen, mobile-friendly chatbot for GTA VI players. Answers stream token by token through [BetterProxy](https://betterproxy.ai), and every request's cache behaviour is logged and monitored in the background.

Built with [BetterProxy](https://betterproxy.ai). The chat says so in the sidebar on a wide screen, in the header on a phone, and again on the welcome screen.

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
| `BETTERPROXY_MODEL` | `gpt-5.4` | Model used for answers. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |
| `MONITOR_TOKEN` | – | If set, the monitor requires `/monitor?token=…`. |
| `CACHE_LOG_FILE` | `logs/cache.jsonl` | Where cache records are appended. |

## Fact sheet

Specific claims about GTA VI come from `knowledge/gta-vi-faq.md`: release, platforms, US prices and editions, the spoiler-free story setup, and what is still unconfirmed. The server reads that file once, at startup, and appends it to the system prompt. The prompt is the same on every request, so repeat questions can hit BetterProxy's cache.

Anything the sheet marks as a rumour — including the reported PC window — has to be answered as a rumour. Questions the sheet does not cover get an honest "not confirmed" rather than a guess. Story answers stay spoiler-free.

## Cache logging and monitoring

For every chat request the server reads BetterProxy's response headers (`X-Cache-Hit`, `X-Cache-Status`, `X-Latency-Ms`, `X-Tokens-Charged`, `X-Credits-Remaining`, `X-Billing-Mode`, `X-RTK-Saved-Tokens`) and measures its own time-to-first-token and total time. Each record is:

- printed to the server console as a `[cache] HIT|MISS …` line,
- appended to `logs/cache.jsonl` (one JSON object per line; counters are rebuilt from it on restart),
- aggregated at `GET /api/cache/stats` (hit rate, hit vs. miss latency, tokens charged, credits left) and shown live at `/monitor`.

BetterProxy currently leaves those headers off **streaming** responses. When they are missing, the server infers hit or miss from the stream itself — a cached answer is replayed as a single chunk, a live one arrives token by token — and marks the record `"cacheSource": "inferred"` (shown as `HIT ~` / `MISS ~`). Tokens charged and credits remaining are only available when the headers are present.

When a response actually carries `X-Cache-Hit: true` or `X-Cache-Status: HIT`, the chat adds a small "instant" mark on that answer. Inferred hits stay in the monitor and are not marked in the chat. Tokens, credits, and the raw log stay server-side.

## Layout

- `server.js` — static files, `/api/chat` streaming proxy, cache recorder
- `knowledge/gta-vi-faq.md` — sourced fact sheet, loaded into the system prompt
- `public/` — chat UI (`index.html`, `styles.css`, `app.js`) and `monitor.html`
