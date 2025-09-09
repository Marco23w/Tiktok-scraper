// server.js
import express from "express";
import { chromium as pwChromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
pwChromium.use(stealth());



const app = express();

// (Opz) API key semplice
const API_KEY = process.env.API_KEY || "";
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// Home utile
app.get("/", (_, res) => res.json({ ok: true, routes: ["/health", "/top50"] }));
app.get("/health", (_, res) => res.json({ ok: true }));

// Utils
function pickHashTags(text = "") {
  const m = text.match(/#\\w+/g) || [];
  return [...new Set(m)].slice(0, 8);
}

function mapFromSIGI(state) {
  const items = state?.ItemModule ? Object.values(state.ItemModule) : [];
  return items.map((v) => ({
    video_id: v.id,
    video_url: `https://www.tiktok.com/@${v.author}/video/${v.id}`,
    author_username: v.author,
    caption: v.desc || "",
    hashtags: pickHashTags(v.desc || ""),
    sound_title: v.music?.title || state?.MusicModule?.music?.title || "",
    sound_artist:
      v.music?.authorName || v.music?.author || state?.MusicModule?.music?.authorName || "",
    views: v.stats?.playCount ?? 0,
    likes: v.stats?.diggCount ?? 0,
    comments: v.stats?.commentCount ?? 0,
    shares: v.stats?.shareCount ?? 0,
    duration_sec: v.video?.duration ?? null,
    published_at: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
    thumbnail_url: v.video?.cover || null,
  }));
}

async function extractFromVideoPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    const sigi = await page.evaluate(() => {
      const n = document.querySelector("#SIGI_STATE");
      if (!n) return null;
      try { return JSON.parse(n.textContent); } catch { return null; }
    });
    const rows = mapFromSIGI(sigi || {});
    // se ci sono più item in pagina, prendi quello con l'id nell'URL
    const id = (url.match(/\\/video\\/(\\d+)/) || [])[1];
    const pick = id ? rows.find(r => r.video_id === id) : rows[0];
    return pick || null;
  } catch (e) {
    console.log("[video extract] fail", url, e?.message);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function getTrendingTop50() {
  const proxyServer = process.env.PROXY_URL || ""; // es. http://user:pass@host:port
const browser = await pwChromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  proxy: proxyServer ? { server: proxyServer } : undefined
});

const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  locale: "it-IT",
  timezoneId: "Europe/Rome",
  extraHTTPHeaders: { "Accept-Language": "it-IT,it;q=0.9" }
});

  // piccola “stealth”
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["it-IT", "it"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });

  const page = await context.newPage();

  async function loadExploreLike(url, scrolls = 18) {
    console.log("[scraper] goto", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // chiudi cookie se appare
    try {
      const btn = page.locator('button:has-text("Accetta"), button:has-text("Accept")').first();
      if (await btn.isVisible()) { await btn.click().catch(() => {}); }
    } catch {}
    await page.waitForTimeout(1500);
    for (let i = 0; i < scrolls; i++) {
      await page.keyboard.press("PageDown");
      await page.waitForTimeout(500 + Math.random() * 500);
    }
    // prova JSON in pagina
    const sigi = await page.evaluate(() => {
      const n = document.querySelector("#SIGI_STATE");
      if (!n) return null;
      try { return JSON.parse(n.textContent); } catch { return null; }
    });
    let rows = mapFromSIGI(sigi || {});
    console.log("[scraper] explore rows:", rows.length);

    // raccogli link ai video come fallback
    const links = await page.evaluate(() => {
      const as = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const urls = as.map(a => a.href.split("?")[0]).filter(Boolean);
      return Array.from(new Set(urls));
    });
    console.log("[scraper] found video links:", links.length);

    return { rows, links };
  }

  // 1) Prova Explore, poi Discover
  let { rows, links } = await loadExploreLike("https://www.tiktok.com/explore");
  if (rows.length < 20 && links.length < 20) {
    const ret = await loadExploreLike("https://www.tiktok.com/discover");
    if (ret.rows.length > rows.length) rows = ret.rows;
    links = [...new Set([...(links || []), ...(ret.links || [])])];
  }

  // 2) Se poche righe da SIGI, arricchisci aprendo le pagine video
  const need = 80; // raccogli abbastanza per poi filtrare
  if (rows.length < need && links.length) {
    const toVisit = links.slice(0, need);
    const collected = [];
    for (const href of toVisit) {
      const item = await extractFromVideoPage(context, href);
      if (item) collected.push(item);
      if (collected.length >= need) break;
    }
    // merge + dedup per video_id
    const map = new Map();
    [...rows, ...collected].forEach(r => { if (r?.video_id) map.set(r.video_id, r); });
    rows = Array.from(map.values());
  }

  await browser.close();

  // 3) filtro 24h (fallback 48h) + scoring velocità
  const now = Date.now();
  const withinHours = (iso, h) => iso && now - new Date(iso).getTime() <= h * 3600 * 1000;

  let recent = rows.filter(r => withinHours(r.published_at, 24));
  if (recent.length < 50) recent = rows.filter(r => withinHours(r.published_at, 48));

  const scored = recent.map(r => {
    const hours = Math.max(1, (now - new Date(r.published_at).getTime()) / 3_600_000);
    const interactions = (r.likes || 0) + 2*(r.comments || 0) + 3*(r.shares || 0);
    const perHour = interactions / hours;
    const er = interactions / Math.max(1, r.views || 0);
    const score = perHour + er * 1000 * 0.25;
    return { ...r, score: Number(score.toFixed(3)), hours_since_post: Number(hours.toFixed(1)) };
  });

  scored.sort((a, b) => b.score - a.score);

  // 4) riempi se <50
  let top = scored.slice(0, 50);
  if (top.length < 50) {
    const filler = rows
      .filter(r => !top.find(t => t.video_id === r.video_id))
      .sort((a, b) => (b.likes+b.comments+b.shares) - (a.likes+a.comments+a.shares))
      .slice(0, 50 - top.length);
    top = top.concat(filler);
  }

  console.log("[scraper] final items:", top.length);
  return top;
}

// API
app.get("/top50", async (_req, res) => {
  try {
    const data = await getTrendingTop50();
    res.json(data);
  } catch (e) {
    console.error("ERR /top50:", e);
    res.status(500).json({ error: "failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("scraper on :" + PORT));
