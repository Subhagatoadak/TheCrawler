/**
 * Web Vision Agent — Fixed & Stealth Edition
 * --------------------------------------------
 * Run locally:
 *   npm install
 *   npx playwright install chromium
 *   ANTHROPIC_API_KEY=sk-ant-... node agent.js https://www.insightslib.com --same-domain
 */

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

chromium.use(StealthPlugin());

// ─── Config ───────────────────────────────────────────────────────────────────
const TARGET_URL = process.argv[2];
const MAX_PAGES   = parseInt((process.argv.find(a => a.startsWith("--max-pages=")) || "=30").split("=")[1]);
const SAME_DOMAIN = process.argv.includes("--same-domain");
const VISIBLE     = process.argv.includes("--visible");

// Site authentication (passed via env vars from the web UI)
const SITE_LOGIN_URL      = process.env.SITE_LOGIN_URL      || null;
const SITE_USERNAME       = process.env.SITE_USERNAME       || null;
const SITE_PASSWORD       = process.env.SITE_PASSWORD       || null;
const SITE_USERNAME_FIELD = process.env.SITE_USERNAME_FIELD || null;
const SITE_PASSWORD_FIELD = process.env.SITE_PASSWORD_FIELD || null;

const OUT_DIR     = path.join(__dirname, "output");
const SHOT_DIR    = path.join(OUT_DIR, "screenshots");

if (!TARGET_URL?.startsWith("http")) {
  console.error("Usage: node agent.js <url> [--max-pages=N] [--same-domain] [--visible]");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function slug(url) {
  return url.replace(/https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 70);
}

function normalizeUrl(raw) {
  try { const u = new URL(raw); u.hash = ""; return u.href; }
  catch { return raw; }
}

function sameDomain(url) {
  try { return new URL(url).hostname === new URL(TARGET_URL).hostname; }
  catch { return false; }
}

// ─── Shared browser / context factory ────────────────────────────────────────
async function makeBrowser() {
  return chromium.launch({
    headless: !VISIBLE,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
}

async function makeContext(browser, storageState = null) {
  const ctx = await browser.newContext({
    viewport:  { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    ...(storageState ? { storageState } : {}),
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return ctx;
}

// ─── Phase 0: Site Login ──────────────────────────────────────────────────────
async function loginToSite() {
  if (!SITE_LOGIN_URL || !SITE_USERNAME || !SITE_PASSWORD) return null;

  console.log("\n🔐 PHASE 0 — Authenticating on target site...\n");
  console.log(`   Login URL : ${SITE_LOGIN_URL}`);

  const browser = await makeBrowser();
  const ctx     = await makeContext(browser);
  const page    = await ctx.newPage();

  try {
    await gotoPage(page, SITE_LOGIN_URL);

    const userSelectors = [
      ...(SITE_USERNAME_FIELD ? [`[name="${SITE_USERNAME_FIELD}"]`, `#${SITE_USERNAME_FIELD}`] : []),
      'input[type="email"]', 'input[autocomplete="email"]', 'input[autocomplete="username"]',
      'input[name="email"]', 'input[name="username"]', 'input[name="user"]',
      'input[name="login"]', 'input[name="identifier"]', 'input[type="text"]',
    ];
    for (const sel of userSelectors) {
      try { await page.fill(sel, SITE_USERNAME, { timeout: 1500 }); console.log("   ✓ Username filled"); break; }
      catch {}
    }

    const passSelectors = [
      ...(SITE_PASSWORD_FIELD ? [`[name="${SITE_PASSWORD_FIELD}"]`, `#${SITE_PASSWORD_FIELD}`] : []),
      'input[type="password"]', 'input[name="password"]',
      'input[name="pass"]',    'input[autocomplete="current-password"]',
    ];
    for (const sel of passSelectors) {
      try { await page.fill(sel, SITE_PASSWORD, { timeout: 1500 }); console.log("   ✓ Password filled"); break; }
      catch {}
    }

    const submitSelectors = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Sign in")', 'button:has-text("Log in")',
      'button:has-text("Login")',   'button:has-text("Continue")',
      '[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try { await page.click(sel, { timeout: 2000 }); submitted = true; break; }
      catch {}
    }
    if (!submitted) await page.keyboard.press("Enter");

    await sleep(3000);

    const storageState = await ctx.storageState();
    const title = await page.title().catch(() => "");
    console.log(`   ✓ Session captured — now on: "${title}"`);
    console.log("\n✅ Authentication complete\n");

    await browser.close();
    return storageState;
  } catch (err) {
    console.log(`   ✗ Login failed: ${err.message.split("\n")[0]}`);
    await browser.close();
    return null;
  }
}

// KEY FIX: use domcontentloaded (not networkidle) then wait a fixed time
async function gotoPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2000); // let JS render
}

// ─── Phase 1: Crawl ───────────────────────────────────────────────────────────
async function crawl(storageState = null) {
  console.log("\n🔍 PHASE 1 — Discovering pages...\n");
  const browser = await makeBrowser();
  const ctx     = await makeContext(browser, storageState);

  const visited = new Set();
  const queue   = [normalizeUrl(TARGET_URL)];
  const pages   = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await ctx.newPage();
    try {
      console.log(`  → [${pages.length + 1}/${MAX_PAGES}] ${url}`);
      await gotoPage(page, url);

      const status = await page.evaluate(() => document.readyState);
      const title  = await page.title().catch(() => url);

      pages.push({ url, title });
      console.log(`     ✓ "${title}"`);

      // Collect all <a href> links
      const links = await page.evaluate(() =>
        [...document.querySelectorAll("a[href]")]
          .map(a => { try { return new URL(a.href, location.href).href; } catch { return null; } })
          .filter(Boolean)
      );

      for (const link of links) {
        const norm = normalizeUrl(link);
        if (!visited.has(norm) && norm.startsWith("http") && (!SAME_DOMAIN || sameDomain(norm))) {
          queue.push(norm);
        }
      }
    } catch (err) {
      console.log(`     ✗ ${err.message.split("\n")[0]}`);
    }
    await page.close();
  }

  await browser.close();
  console.log(`\n✅ Discovered ${pages.length} page(s)\n`);
  return pages;
}

// ─── Phase 2: Screenshot ──────────────────────────────────────────────────────
async function screenshot(pages, storageState = null) {
  console.log("📸 PHASE 2 — Taking screenshots...\n");
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await makeBrowser();
  const ctx     = await makeContext(browser, storageState);
  const results = [];

  for (const { url, title } of pages) {
    const s     = slug(url);
    const shots = [];
    const page  = await ctx.newPage();

    try {
      console.log(`\n  📄 ${title}`);
      await gotoPage(page, url);

      // 1. Full-page initial screenshot
      const initPath = path.join(SHOT_DIR, `${s}__initial.png`);
      await page.screenshot({ path: initPath, fullPage: true });
      shots.push({ label: "Initial page", path: initPath });
      console.log(`     ✓ Initial screenshot`);

      // 2. Native <select> elements
      const selects = await page.$$("select");
      for (let i = 0; i < Math.min(selects.length, 4); i++) {
        try {
          const opts = await selects[i].evaluate(el =>
            [...el.options].map(o => ({ v: o.value, t: o.text })).filter(o => o.v)
          );
          for (const opt of opts.slice(0, 3)) {
            await selects[i].selectOption(opt.v);
            await sleep(500);
            const p = path.join(SHOT_DIR, `${s}__sel${i}_${slug(opt.v)}.png`);
            await page.screenshot({ path: p, fullPage: false });
            shots.push({ label: `Select #${i} → "${opt.t}"`, path: p });
          }
          console.log(`     ✓ Select #${i}: ${Math.min(opts.length, 3)} option(s)`);
        } catch { /* skip */ }
      }

      // 3. Custom dropdowns (ARIA / Bootstrap / Tailwind)
      const dropdownSel = [
        '[aria-haspopup="true"]',
        '[aria-haspopup="listbox"]',
        '[data-toggle="dropdown"]',
        '[data-bs-toggle="dropdown"]',
        ".dropdown-toggle",
        '[role="combobox"]',
      ].join(", ");

      const triggers = await page.$$(dropdownSel);
      for (let i = 0; i < Math.min(triggers.length, 5); i++) {
        try {
          await triggers[i].scrollIntoViewIfNeeded();
          await triggers[i].click();
          await sleep(700);
          const p = path.join(SHOT_DIR, `${s}__dropdown${i}.png`);
          await page.screenshot({ path: p, fullPage: false });
          shots.push({ label: `Dropdown #${i} open`, path: p });
          await page.keyboard.press("Escape");
          await sleep(300);
          console.log(`     ✓ Dropdown #${i}`);
        } catch { /* skip */ }
      }

      // 4. Navigation menus (hover-based)
      const navItems = await page.$$("nav a, header a, .navbar a, .menu a");
      for (let i = 0; i < Math.min(navItems.length, 5); i++) {
        try {
          await navItems[i].hover();
          await sleep(500);
          const p = path.join(SHOT_DIR, `${s}__nav${i}.png`);
          await page.screenshot({ path: p, fullPage: false });
          shots.push({ label: `Nav hover #${i}`, path: p });
        } catch { /* skip */ }
      }

    } catch (err) {
      console.log(`     ✗ ${err.message.split("\n")[0]}`);
    }

    await page.close();
    results.push({ url, title, shots });
    console.log(`     → ${shots.length} screenshot(s) saved`);
  }

  await browser.close();
  console.log(`\n✅ Screenshots done\n`);
  return results;
}

// ─── Phase 3: Analyse with Claude Vision ──────────────────────────────────────
async function analyse(results) {
  console.log("🤖 PHASE 3 — Analysing with Claude Vision...\n");
  const client   = new Anthropic();
  const analysed = [];

  for (const { url, title, shots } of results) {
    if (!shots.length) {
      analysed.push({ url, title, analysis: "No screenshots captured." });
      continue;
    }

    console.log(`  🧠 ${title || url} (${shots.length} image(s))`);

    const content = [];
    for (const shot of shots.slice(0, 10)) {
      try {
        const b64 = fs.readFileSync(shot.path).toString("base64");
        content.push({ type: "text", text: `\n[${shot.label}]` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
      } catch { /* missing file */ }
    }

    content.push({
      type: "text",
      text: `Analyse this web page (URL: ${url}). Provide:
1. **Page Purpose** — what is this page for?
2. **Key UI Elements** — forms, dropdowns, buttons, nav items
3. **Content & Value** — main information / offerings shown
4. **User Flow** — what actions can the user take?
5. **Observations** — UX notes, design patterns
6. **Extracted Data** — any prices, features, CTAs, categories visible`,
    });

    try {
      const resp = await client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1200,
        messages: [{ role: "user", content }],
      });
      const analysis = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      analysed.push({ url, title, shots: shots.map(s => s.label), analysis });
      console.log(`     ✓ Done`);
    } catch (err) {
      console.log(`     ✗ Claude error: ${err.message}`);
      analysed.push({ url, title, shots: [], analysis: `Error: ${err.message}` });
    }

    await sleep(400);
  }

  return analysed;
}

// ─── Phase 4: Report ──────────────────────────────────────────────────────────
function report(analysed) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(analysed, null, 2));

  const md = [
    `# Web Vision Report — ${TARGET_URL}`,
    `Generated: ${new Date().toLocaleString()}  |  Pages: ${analysed.length}\n\n---\n`,
  ];
  for (const p of analysed) {
    md.push(`## ${p.title || p.url}`);
    md.push(`**URL:** ${p.url}\n`);
    md.push(p.analysis);
    md.push("\n---\n");
  }
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), md.join("\n"));

  console.log(`\n📄 Reports saved to ./output/`);
  console.log(`   report.md   — human-readable`);
  console.log(`   report.json — structured data`);
  console.log(`   screenshots/ — ${fs.readdirSync(SHOT_DIR).length} image(s)\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🕷️  The Crawler`);
  console.log(`   URL      : ${TARGET_URL}`);
  console.log(`   Max pages: ${MAX_PAGES}`);
  console.log(`   Domain   : ${SAME_DOMAIN ? "same only" : "follow all"}`);
  if (SITE_LOGIN_URL) console.log(`   Auth     : ${SITE_LOGIN_URL}`);
  console.log("");

  const storageState = await loginToSite();

  const pages   = await crawl(storageState);
  if (!pages.length) { console.error("❌ No pages found. Try without --same-domain or check the URL."); process.exit(1); }

  const shots   = await screenshot(pages, storageState);
  const results = await analyse(shots);
  report(results);

  console.log("🎉 All done!\n");
})();
