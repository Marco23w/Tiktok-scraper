// server.js
import express from "express";
import playwright from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

playwright.use(StealthPlugin());

const app = express();

// ---- util
const HEADLESS = (process.env.HEADLESS ?? "true") !== "false";
const LIMIT_DEFAULT = parseInt(process.env.LIMIT ?? "50", 10);
const BASE_EXPLORE = "https://www.tiktok.com/explore?lang=en";
const VIEWPORT = { width: 1366, height: 768 };

// cache in-memory per evitare run pesanti ripetuti
let lastCache = { ts: 0, data: [] };
const TTL_MS = 1000 * 60 * 15; // 15 minuti

app.get("/", (_req, res) =>
  res.json({ ok: true, routes: ["/health", "/debug", "/top50"] })
);
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- helpers browser
async function newContext() {
  const browser = await playwright.chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    geolocation: { latitude: 41.9028, longitude: 12.4964 }, // Roma
    permissions: ["geolocation"],
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  return { browser, context };
}

async function acceptCookiesEverywhere(page) {
  const labels = [
    "Accept all",
    "Accept All",
    "I agree",
    "Agree",
    "Accetta",
    "Accetta tutto",
    "Accetta tutti",
    "Consenti tutto",
  ];
  // prova sia nella main page che in tutti gli iframe
  const frames = [page, ...page.frames()];
  for (const f of frames) {
    for (const text of labels) {
      try {
        const btn = f.locator(`button:has-text("${text}")`);
        if (await btn.first().isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.first().click({ delay: 50 });
          await page.waitForTimeout(500);
          return true;
        }
      } catch {}
    }
    // fallback generico su "text=Accept" / "text=Accetta"
    try {
      const any = f.locator('text=/^(Accept|Accetta).*/i');
      if (await any.first().isVisible({ timeout: 500 }).catch(() => false)) {
        await any.first().click({ delay: 50 });
        await page.waitForTimeout(500);
        return true;
      }
    } catch {}
  }
  return false;
}

async function scrollToLoad(page, { steps = 12, waitMs = 900 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(waitMs + Math.random() * 400);
  }
}

async function extractJSONWithItemModule(page) {
  // Cerca uno <script> che contenga "ItemModule" (TikTok cambia spesso id/struttura)
  return await page.evaluate(() => {
    const scripts = Array.from(document.scripts);
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.includes('"ItemModule"')) {
        try {
          return JSON.parse(t);
        } catch (_) {}
      }
    }
    // alcuni build salvano JSON su script[type="application/json"]
    const jsonScripts = Array.from(
      document.querySelectorAll('script[type="application/json"]')
    );
    for (const s of jsonScripts) {
      const t = s.textContent || "";
      if (t.includes('"ItemModule"')) {
        try {
          return JSON.parse(t);
        } catch (_) {}
      }
    }
    return null;
  });
}

function pickHashTags(text = "") {
  const m = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(m)].slice(0, 10);
}

function mapFromSIGI(state) {
  const items = state?.ItemModule ? Object.values(state.ItemModule) : [];
  return items.map((v) => ({
    video_id: v.id,
    video_url: `https://www.tiktok.com/@${v.author}/video/${v.id}`,
    author_username: v.author,
    caption: v.desc || "",
    hashtags: pickHashTags(v.desc || ""),
    sound_title: state?.MusicModule?.music?.title || v.music?.title || "",
    sound_artist:
      state?.MusicModule?.music?.authorName ||
      v.music?.authorName ||
      v.music?.author ||
      "",
    views: v.stats?.playCount ?? 0,
    likes: v.stats?.diggCount ?? 0,
    comments: v.stats?.commentCount ?? 0,
    shares: v.stats?.shareCount ?? 0,
    duration_sec: v.video?.duration ?? null,
    published_at: v.createTime
      ? new Date(v.createTime * 1000).toISOString()
      : null,
    thumbnail_url: v.video?.cover || v.video?.originCover || null,
  }));
}

async function getExploreVideoLinks(page, min = 60, maxSteps = 16) {
  await page.goto(BASE_EXPLORE, { waitUntil: "domcontentloaded" });
  await acceptCookiesEverywhere(page);
  const urls = new Set();
  for (let i = 0; i < maxSteps; i++) {
    // raccogli link ai video
    const hrefs = await page
      .locator('a[href*="/video/"]')
      .evaluateAll((as) => as.map((a) => a.href));
    hrefs.forEach((h) => urls.add(h.split("?")[0]));
    if (urls.size >= min) break;
    await scrollToLoad(page);
  }
  return [...urls].slice(0, 120);
}

async function extractFromVideoPage(context, url) {
  const page = await context.newPage();
  try {
    // riduci banda (non blocco XHR/JS)
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await acceptCookiesEverywhere(page);
    const state = await extractJSONWithItemModule(page);
    if (!state) return null;
    const rows = mapFromSIGI(state).filter((r) => r.video_url.includes("/video/"));
    // su pagina video ci sarà 1 solo item
    return rows[0] ?? null;
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function getTopTrending(limit = LIMIT_DEFAULT) {
  // cache 15'
  const now = Date.now();
  if (now - lastCache.ts < TTL_MS && lastCache.data.length) {
    return lastCache.data.slice(0, limit);
  }

  const { browser, context } = await newContext();
  try {
    const page = await context.newPage();
    // prima prova a prendere direttamente l'ItemModule su Explore
    await page.goto(BASE_EXPLORE, { waitUntil: "domcontentloaded", timeout: 45000 });
    await acceptCookiesEverywhere(page);
    await scrollToLoad(page);
    let state = await extractJSONWithItemModule(page);

    let rows = [];
    if (state?.ItemModule) {
      rows = mapFromSIGI(state);
    }

    // Fallback: se Explore non dà JSON, entra nelle pagine video
    if (!rows.length) {
      const links = await getExploreVideoLinks(page, 60, 18);
      // batch a 6 per non stressare
      const batchSize = 6;
      const metas = [];
      for (let i = 0; i < links.length; i += batchSize) {
        const chunk = links.slice(i, i + batchSize);
        const part = await Promise.all(
          chunk.map((u) => extractFromVideoPage(context, u))
        );
        metas.push(...part.filter(Boolean));
        // fermati quando hai già superato il limite x2 (per ordinare dopo)
        if (metas.length >= limit * 2) break;
      }
      rows = metas;
    }

    // ordina per engagement
    rows.sort(
      (a, b) =>
        (b.likes + b.comments + b.shares + (b.views || 0) / 20) -
        (a.likes + a.comments + a.shares + (a.views || 0) / 20)
    );

    const top = rows
      .filter((r) => r && r.video_url)
      .slice(0, limit);

    lastCache = { ts: now, data: top };
    return top;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// --------- routes
app.get("/debug", async (_req, res) => {
  const { browser, context } = await newContext();
  const page = await context.newPage();
  let info = { url: BASE_EXPLORE, title: null, hasSIGI: false, challenge: false, linkCount: 0, firstLinks: [] };
  try {
    await page.goto(BASE_EXPLORE, { waitUntil: "domcontentloaded", timeout: 45000 });
    await acceptCookiesEverywhere(page);
    await page.waitForTimeout(1200);
    info.title = await page.title();
    const state = await extractJSONWithItemModule(page);
    info.hasSIGI = Boolean(state && state.ItemModule);
    const links = await page.locator('a[href*="/video/"]').evaluateAll((as) => as.map((a) => a.href));
    info.linkCount = links.length;
    info.firstLinks = links.slice(0, 5);
    info.challenge = /verify|challenge/i.test(info.title) || /challenge/.test(page.url());
  } catch (e) {
    info.error = e?.message || String(e);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  res.json(info);
});

app.get("/top50", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? LIMIT_DEFAULT, 10) || LIMIT_DEFAULT, 100);
  try {
    const rows = await getTopTrending(limit);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "scrape_failed", msg: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("scraper on :" + PORT));
