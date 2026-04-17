# 🕵️ The Crawler

A fully automated agent that:
1. **Crawls** all pages connected to a starting URL
2. **Screenshots** each page — including opened dropdowns, selects, and radio states
3. **Analyses** every screenshot with Claude Vision to extract structured insights

---

## Prerequisites

- Node.js 18+
- An Anthropic API key

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browser (Chromium)
npx playwright install chromium

# 3. Set your API key
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Usage

```bash
# Basic — crawl up to 30 pages from a URL
node agent.js https://example.com

# Limit pages and restrict to same domain only
node agent.js https://example.com --max-pages=10 --same-domain
```

---

## Output

All output is saved to `./output/`:

```
output/
├── screenshots/
│   ├── https_example_com_initial.png
│   ├── https_example_com_select0_option1.png
│   ├── https_example_com_dropdown0.png
│   └── ...
├── report.json      ← Full structured data
└── report.md        ← Human-readable markdown report
```

---

## What It Captures

| Interaction | How |
|---|---|
| Page load | Full-page screenshot |
| `<select>` dropdowns | Selects each option (up to 3), screenshots each state |
| Custom dropdowns | Clicks `[aria-haspopup]`, `.dropdown-toggle`, etc. |
| Radio buttons | Checks each radio group, screenshots result |
| Escape to close | Presses Escape after each custom dropdown |

---

## What Claude Extracts Per Page

- **Page Purpose** — what user goal the page serves
- **Key UI Elements** — forms, buttons, nav, dropdowns
- **Content Insights** — primary information/value
- **User Flow** — actions available, what comes next
- **UX Observations** — patterns, issues, notable design
- **Structured Data** — prices, features, CTAs, links

---

## Configuration

Edit the top of `agent.js` to change defaults:

```js
const MAX_PAGES = 30;           // default page limit
const SAME_DOMAIN_ONLY = false; // follow external links?
```

Or pass as CLI flags:
```bash
node agent.js https://mysite.com --max-pages=50 --same-domain
```

---

## Architecture

```
Start URL
    │
    ▼
[Phase 1: Crawler]
  Playwright BFS → collect all linked URLs
    │
    ▼
[Phase 2: Screenshot Agent]
  For each URL:
    - Load page
    - Screenshot (full page)
    - Open each <select>, screenshot per option
    - Click custom dropdowns, screenshot
    - Check radio groups, screenshot
    │
    ▼
[Phase 3: Claude Vision Analysis]
  Send all screenshots per page to claude-opus
  Extract structured insights
    │
    ▼
[Phase 4: Report]
  output/report.md + output/report.json
```
