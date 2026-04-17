# 🕷️ The Crawler

> A stealth web crawler powered by Claude Vision. Discovers pages, captures UI states, and generates structured analysis reports — all through a clean web interface.

---

## Features

| Capability | Detail |
|---|---|
| **Multi-phase pipeline** | Crawl → Screenshot → AI Analysis → Report |
| **Claude Vision analysis** | Per-page: purpose, UI elements, user flows, extracted data |
| **UI state capture** | Native selects, custom dropdowns, nav hover states |
| **Site authentication** | Log in to target sites before crawling (session cookies shared across all phases) |
| **Web UI** | Browser-based interface with live log streaming |
| **Auth wall** | Login-protected with session management and rate limiting |
| **Crawl history** | Last 50 runs persisted locally |
| **Export** | Download full report + screenshots as `.zip` |
| **Docker-ready** | Single `docker compose up` to run everything |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (User)                           │
│                                                                 │
│   ┌──────────────────────────────────────────────────────┐      │
│   │  Web UI  (public/index.html)                         │      │
│   │  • Configure crawl  • Live log stream (SSE)          │      │
│   │  • Site auth form   • Results viewer + export        │      │
│   └──────────────────────┬───────────────────────────────┘      │
└─────────────────────────-│───────────────────────────────────────┘
                           │ HTTP / SSE
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Express Server  (server.js)                   │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐ │
│  │  Auth layer  │  │  Rate limiter  │  │  Session (8h cookie)  │ │
│  │  /login POST │  │  10 req/15min  │  │  express-session      │ │
│  └──────────────┘  └───────────────┘  └───────────────────────┘ │
│                                                                  │
│  POST /api/crawl ──► spawn child process (node agent.js)        │
│  GET  /api/stream ──► SSE: broadcast stdout/stderr live         │
│  GET  /api/history ──► crawl-history.json (last 50 runs)        │
│  GET  /api/export ──► zip output/ with archiver                 │
│  GET  /screenshots/* ──► static file serve                      │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ child_process.spawn
                               │ env: SITE_LOGIN_URL, SITE_USERNAME…
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Crawler Agent  (agent.js)                     │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Phase 0 — Site Authentication (optional)               │   │
│   │  Playwright navigates to login URL, fills credentials,  │   │
│   │  captures storageState (cookies + localStorage)         │   │
│   └────────────────────────┬────────────────────────────────┘   │
│                            │ storageState injected below        │
│   ┌────────────────────────▼────────────────────────────────┐   │
│   │  Phase 1 — Crawl                                        │   │
│   │  Playwright BFS from start URL → collect all page URLs  │   │
│   │  Stealth plugin: hides automation signals               │   │
│   └────────────────────────┬────────────────────────────────┘   │
│                            │                                    │
│   ┌────────────────────────▼────────────────────────────────┐   │
│   │  Phase 2 — Screenshot                                   │   │
│   │  For each page:                                         │   │
│   │  • Full-page screenshot                                 │   │
│   │  • Native <select> — each option                        │   │
│   │  • Custom dropdowns — click & capture                   │   │
│   │  • Nav items — hover states                             │   │
│   └────────────────────────┬────────────────────────────────┘   │
│                            │                                    │
│   ┌────────────────────────▼────────────────────────────────┐   │
│   │  Phase 3 — Claude Vision Analysis                       │   │
│   │  Batches screenshots per page → claude-opus-4-5         │   │
│   │  Extracts: purpose · UI elements · user flows ·         │   │
│   │            content · UX observations · structured data  │   │
│   └────────────────────────┬────────────────────────────────┘   │
│                            │                                    │
│   ┌────────────────────────▼────────────────────────────────┐   │
│   │  Phase 4 — Report                                       │   │
│   │  output/report.md   (human-readable markdown)           │   │
│   │  output/report.json (structured data)                   │   │
│   │  output/screenshots/*.png                               │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Docker (recommended)

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, change ADMIN_PASSWORD and SESSION_SECRET

# 2. Build and run
docker compose up --build

# 3. Open the UI
open http://localhost:9786
```

### Local

```bash
# 1. Install dependencies
npm install

# 2. Install Chromium for Playwright
npx playwright install chromium

# 3. Configure
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY

# 4. Start the server
npm start
# → http://localhost:9786
```

---

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Yes** | — | Anthropic API key for Claude Vision |
| `PORT` | No | `9786` | Web server port |
| `ADMIN_USERNAME` | No | `admin` | Web UI login username |
| `ADMIN_PASSWORD` | No | `admin` | Web UI login password — **change this** |
| `SESSION_SECRET` | No | hardcoded | Secret for signing session cookies — **change this** |

---

## Web UI

### Running a crawl

1. Sign in at `http://localhost:9786/login`
2. Enter the target URL
3. Set **Max pages** (default 30) and optionally enable **Same domain only**
4. Click **Start Crawl** — live logs stream in real time
5. When complete, view the **Report**, **Screenshots**, or **Raw JSON** tabs
6. Click **Download .zip** to export the full report

### Crawling sites that require login

Toggle **"Target site requires login"** to reveal the authentication form:

| Field | Description |
|---|---|
| Login URL | The page with the sign-in form |
| Username / Email | Credential to fill in |
| Password | Credential to fill in |
| Username input name _(advanced)_ | `name` attribute of the username field if auto-detection fails |
| Password input name _(advanced)_ | `name` attribute of the password field if auto-detection fails |

The crawler will authenticate in **Phase 0**, capture the session cookies, and inject them into every subsequent Playwright context so the crawl and screenshots run fully authenticated.

### CLI (without the web server)

```bash
# Basic
node agent.js https://example.com

# Limit pages, same-domain only
node agent.js https://example.com --max-pages=10 --same-domain

# With site authentication
SITE_LOGIN_URL=https://example.com/login \
SITE_USERNAME=user@example.com \
SITE_PASSWORD=secret \
node agent.js https://example.com/dashboard --same-domain
```

---

## Output Structure

```
output/
├── screenshots/
│   ├── example_com__initial.png          ← full-page load
│   ├── example_com__sel0_option1.png     ← <select> option state
│   ├── example_com__dropdown0.png        ← custom dropdown open
│   ├── example_com__nav0.png             ← nav hover state
│   └── ...
├── report.json     ← structured analysis (array of pages)
└── report.md       ← human-readable markdown report

crawl-history.json  ← persisted run history (last 50, gitignored)
```

### Report fields per page

```json
{
  "url": "https://example.com/pricing",
  "title": "Pricing — Example",
  "shots": ["Initial page", "Dropdown #0 open"],
  "analysis": "1. Page Purpose...\n2. Key UI Elements...\n..."
}
```

---

## Project Structure

```
TheCrawler/
├── agent.js            ← crawler pipeline (Phases 0–4)
├── server.js           ← Express web server + auth + SSE
├── public/
│   ├── index.html      ← main web UI (SPA)
│   └── login.html      ← login page
├── output/             ← generated per-run (gitignored)
├── crawl-history.json  ← run history (gitignored)
├── Dockerfile
├── docker-compose.yml
├── .env                ← secrets (gitignored)
└── .env.example        ← template to copy
```

---

## Security

### Defaults to change before deploying

```bash
# .env
ADMIN_PASSWORD=<strong-random-password>
SESSION_SECRET=<64-char-random-string>

# Generate a secret:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Built-in protections

| Protection | Implementation |
| --- | --- |
| Login rate limiting | 10 attempts per IP per 15 minutes (`express-rate-limit`) |
| Session cookies | `httpOnly`, 8-hour expiry, signed with `SESSION_SECRET` |
| Auth wall | All routes except `/login` and `POST /api/login` require a valid session |
| No credential exposure | Target site passwords are passed as env vars to the child process, not as CLI args visible in `ps` |

### Operational recommendations

- **Never expose port 9786 directly to the internet.** Put it behind a reverse proxy (nginx, Caddy) with HTTPS.
- **Use HTTPS in production.** Without TLS, session cookies travel in plaintext. Add `cookie: { secure: true }` in `server.js` when behind HTTPS.
- **Respect `robots.txt`** and the target site's terms of service. This tool is for authorised analysis only.
- **Rotate credentials** if you share the Docker image or `.env` with others.
- **Treat `output/` as sensitive.** It contains full-page screenshots and may capture personal data from the crawled site. Delete or restrict it when no longer needed.
- **Don't commit `.env`** — it is gitignored by default. Use `docker secret` or a secrets manager in production.
- **Site credentials** entered in the UI are sent over HTTPS (once you have TLS) and passed only as environment variables to the subprocess — they are never logged or persisted.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `failed to resolve source metadata` for Docker image | Use `node:20-bookworm` base (already set) — the `mcr.microsoft.com/playwright/node` registry can be unavailable |
| Blank screenshots | Some SPAs need longer hydration time — increase the `sleep(2000)` in `gotoPage` |
| Login not working | Enable **Advanced field selectors** and supply the exact `name` attribute of the form inputs |
| `ANTHROPIC_API_KEY` error | Ensure the key is set in `.env` and the container was rebuilt after editing |
| Port already in use | Change `PORT` in `.env` and the `docker-compose.yml` mapping |

---

## License

MIT
