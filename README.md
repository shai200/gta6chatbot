# Leonida Intel — GTA VI companion chatbot

A full-screen, mobile-friendly chatbot for GTA VI players. Answers stream token by token through [BetterProxy](https://betterproxy.ai), and every request's cache behaviour is logged and monitored in the background.

Built with [BetterProxy](https://betterproxy.ai). The chat says so in the sidebar on a wide screen, in the header on a phone, and again on the welcome screen.

Unofficial fan-made project. Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.

## Run

Requires Node 22.5+ (no dependencies to install; tips use Node's built-in SQLite).

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
| `COMMUNITY_DB` | `data/community.db` | Local SQLite file for player tips. |
| `DAILY_REQUEST_CAP` | `150` | Model calls per UTC day, including the optional tip check. `0` never calls the model. |
| `QUESTION_LIMIT` | `20` | Questions per IP (and per browser) per window. |
| `QUESTION_WINDOW_SEC` | `600` | Window for `QUESTION_LIMIT`. |
| `TIP_LIMIT` | `8` | New tips per IP and per browser per window. |
| `TIP_WINDOW_SEC` | `3600` | Window for `TIP_LIMIT`. |
| `VOTE_LIMIT` | `60` | Votes per IP and per browser per window. |
| `VOTE_WINDOW_SEC` | `3600` | Window for `VOTE_LIMIT`. |
| `TRUST_UPVOTES` | `3` | Net upvotes before a tip is trusted and shown to the bot. |
| `HIDE_FLAGS` | `3` | Flags that hide a tip. A bad flag-to-upvote ratio hides one too. |
| `MODERATION_LLM` | on | Set to `0` to skip the optional BetterProxy tip check. Rules still run. |

## Community playbook

Players can leave a tip when the bot does not know, or suggest one under any answer. No account. A nickname is optional. The browser keeps an anonymous id, and the server rate-limits by that id and by a hash of the IP. Raw IPs are not stored.

New tips are labelled "unverified community tip". After 3 net upvotes they are trusted. Three flags, or a lopsided flag ratio, hides a tip. There is no manual moderation. A rule filter blocks links, slurs, profanity, and repeats. If a BetterProxy key is set, one short cached check can also reject a tip; if that call fails or the daily cap is already spent, the rules stand and the tip is still accepted.

Trusted tips that match a question are added in a separate message, after the stable system prompt, and credited as "tip from the community (nickname)". The fact sheet wins if a tip disagrees with it. Spoiler-marked tips stay out of answers unless the player asked for spoilers.

The playbook is at `/playbook`, sorted by votes, with search and topic filters.

## Railway

Deploy the repo the way it already deploys. No new service, database plugin, or env var is required, and none of this asks for a credit card.

Tips are written to `data/community.db` on the service disk. That disk is ephemeral: tips last until the next deploy or container replacement. That path costs nothing extra.

To keep tips across deploys, stay on Railway's Free plan (no card; it includes one 0.5 GB volume and $1 of usage a month):

1. Add a volume to the existing service and mount it at `/data`.
2. Set one variable: `COMMUNITY_DB=/data/community.db`.

Volume storage is billed at Railway's usual rate and drawn from the included $1. A tips file stays far under a megabyte, so this is a fraction of a cent, not a card charge. Do not upgrade to Hobby for this. Hobby is $5 a month and requires a card. Do not add Postgres, Supabase, or Turso.

If the daily model cap is hit, chat stops calling BetterProxy and answers from the fact sheet and trusted tips only, with a short note. Set `DAILY_REQUEST_CAP=0` to never call the model.

## Fact sheet

Specific claims about GTA VI come from `knowledge/gta-vi-faq.md`: release, platforms, US prices and editions, the spoiler-free story setup, and what is still unconfirmed. The server reads that file once, at startup, and appends it to the system prompt. The prompt is the same on every request, so repeat questions can hit BetterProxy's cache.

Anything the sheet marks as a rumour — including the reported PC window — has to be answered as a rumour. Questions the sheet does not cover get an honest "not confirmed" rather than a guess. Story answers stay spoiler-free.

## Cache logging and monitoring

For every chat request the server reads BetterProxy's response headers (`X-Cache-Hit`, `X-Cache-Status`, `X-Latency-Ms`, `X-Tokens-Charged`, `X-Credits-Remaining`, `X-Billing-Mode`, `X-RTK-Saved-Tokens`) and measures its own time-to-first-token and total time. Each record is:

- printed to the server console as a `[cache] HIT|MISS …` line,
- appended to `logs/cache.jsonl` (one JSON object per line; counters are rebuilt from it on restart),
- aggregated at `GET /api/cache/stats` (hit rate, hit vs. miss latency, tokens charged, credits left) and shown live at `/monitor`.

BetterProxy currently leaves those headers off **streaming** responses. The monitor still notes the stream shape — a cached answer is replayed as one chunk, a live one arrives token by token — as `"cacheSource": "inferred"` (`HIT ~` / `MISS ~`). Tokens charged and credits remaining are only available when the headers are present.

The chat shows "instant" when a header says hit (`X-Cache-Hit: true` or `X-Cache-Status: HIT`). With no header, it shows "instant" only for a repeat of the exact same prompt whose first token arrived within 400ms and whose body matches the previous answer or came back as a single chunk. The first time a prompt is seen is not marked. A header that says miss is trusted over that timing rule.

## Layout

- `server.js` — static files, `/api/chat` streaming proxy, cache recorder, community routes
- `lib/community.js` — local SQLite tips, votes, rate limits, daily cap
- `lib/text.js` — keyword retrieval, spam rules, and the separate tip message
- `lib/cache.js` — decides when a reply was served from cache
- `knowledge/gta-vi-faq.md` — sourced fact sheet, loaded into the system prompt
- `public/` — chat UI, `playbook.html`, and `monitor.html`
