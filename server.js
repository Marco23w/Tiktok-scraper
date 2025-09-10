// server.js - Versione completa e testata
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());

// Configuration
const CONFIG = {
  HEADLESS: (process.env.HEADLESS ?? "true") !== "false",
  LIMIT_DEFAULT: parseInt(process.env.LIMIT ?? "50", 10),
  PORT: process.env.PORT || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  CACHE_TTL_MS: parseInt(process.env.CACHE_TTL_MINUTES ?? "15", 10) * 60 * 1000,
  BASE_EXPLORE: "https://www.tiktok.com/foryou?lang=en",
  VIEWPORT: { width: 1920, height: 1080 },
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 45000
};

// Simple logger
const logger = {
  info: (...args) => CONFIG.LOG_LEVEL !== "silent" && console.log(new Date().toISOString(), "[INFO]", ...args),
  error: (...args) => console.error(new Date().toISOString(), "[ERROR]", ...args),
  warn: (...args) => CONFIG.LOG_LEVEL === "debug" && console.warn(new Date().toISOString(), "[WARN]", ...args),
  debug: (...args) => CONFIG.LOG_LEVEL === "debug" && console.log(new Date().toISOString(), "[DEBUG]", ...args)
};

// Simple cache
class SimpleCache {
  constructor(ttl = CONFIG.CACHE_TTL_MS) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    const expires = Date.now() + this.ttl;
    this.cache.set(key, { value, expires });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const cache = new SimpleCache();

// Browser utilities
async function createBrowserContext(retries = 0) {
  try {
    const browser = await chromiumExtra.launch({
      headless: CONFIG.HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run"
      ],
    });

    const context = await browser.newContext({
      viewport: CONFIG.VIEWPORT,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { latitude: 40.7128, longitude: -74.0060 },
      permissions: ["geolocation"],
      hasTouch: false,
      deviceScaleFactor: 1,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return { browser, context };
  } catch (error) {
    logger.error("Failed to create browser context:", error.message);
    if (retries < CONFIG.MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 2000 * (retries + 1)));
      return createBrowserContext(retries + 1);
    }
    throw error;
  }
}

async function acceptCookiesEverywhere(page) {
  const cookieSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")', 
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    '[data-e2e="cookie-banner-ok"]'
  ];

  for (const selector of cookieSelectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
        await element.click({ delay: 100 });
        await page.waitForTimeout(500);
        return true;
      }
    } catch (e) {
      // Continue
    }
  }
  return false;
}

async function smartScroll(page, options = {}) {
  const { steps = 8, waitMs = 2000 } = options;
  
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 800 + Math.random() * 400);
    await page.waitForTimeout(waitMs + Math.random() * 500);
  }
}

// Data extraction
async function extractTikTokData(page) {
  return await page.evaluate(() => {
    let state = null;
    
    // Try window objects
    const windowObjects = ['__INITIAL_STATE__', 'SIGI_STATE', '__NEXT_DATA__'];
    for (const obj of windowObjects) {
      if (window[obj]) {
        state = window[obj];
        break;
      }
    }
    
    // Try script tags
    if (!state) {
      const scripts = Array.from(document.scripts);
      for (const script of scripts) {
        const text = script.textContent || '';
        if (text.length < 1000) continue;
        
        const patterns = [
          /window\.__INITIAL_STATE__\s*=\s*({.+?});/s,
          /SIGI_STATE\s*=\s*({.+?});/s,
          /"ItemModule":\s*({.+?})/s
        ];
        
        for (const pattern of patterns) {
          try {
            const match = text.match(pattern);
            if (match && match[1]) {
              const parsed = JSON.parse(match[1]);
              if (parsed.ItemModule || parsed.itemModule) {
                state = parsed;
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        if (state) break;
      }
    }
    
    return state;
  });
}

async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const videos = [];
    const links = document.querySelectorAll('a[href*="/video/"]');
    
    for (const link of links) {
      try {
        const href = link.href;
        const match = href.match(/\/@([^/]+)\/video\/(\d+)/);
        if (!match) continue;
        
        const [, username, videoId] = match;
        
        videos.push({
          video_id: videoId,
          video_url: href,
          author_username: username,
          caption: "",
          hashtags: [],
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          published_at: new Date().toISOString(),
          source: 'DOM_extraction'
        });
      } catch (e) {
        continue;
      }
    }
    
    return videos;
  });
}

function extractHashtags(text = "") {
  if (!text) return [];
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(matches)].slice(0, 10);
}

function mapVideoData(state) {
  if (!state) return [];
  
  let items = [];
  if (state.ItemModule) {
    items = Object.values(state.ItemModule);
  } else if (state.itemModule) {
    items = Object.values(state.itemModule);
  }
  
  return items.map(item => {
    try {
      return {
        video_id: item.id,
        video_url: `https://www.tiktok.com/@${item.author}/video/${item.id}`,
        author_username: item.author,
        author_display_name: item.authorName || item.author,
        caption: item.desc || "",
        hashtags: extractHashtags(item.desc || ""),
        sound_title: item.music?.title || "",
        sound_artist: item.music?.authorName || "",
        views: item.stats?.playCount || 0,
        likes: item.stats?.diggCount || 0,
        comments: item.stats?.commentCount || 0,
        shares: item.stats?.shareCount || 0,
        duration_sec: item.video?.duration || null,
        published_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null,
        thumbnail_url: item.video?.cover || null,
        engagement_rate: item.stats?.playCount ? 
          ((item.stats.diggCount + item.stats.commentCount + item.stats.shareCount) / 
           Math.max(item.stats.playCount, 1) * 100).toFixed(2) : 0
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

async function getExploreVideos(page, minVideos = 50) {
  await page.goto(CONFIG.BASE_EXPLORE, { 
    waitUntil: "domcontentloaded", 
    timeout: CONFIG.REQUEST_TIMEOUT 
  });
  
  await acceptCookiesEverywhere(page);
  await page.waitForTimeout(3000);
  
  // Try JSON extraction
  let state = await extractTikTokData(page);
  let videos = mapVideoData(state);
  
  // Fallback to DOM extraction
  if (videos.length === 0) {
    videos = await extractFromDOM(page);
  }
  
  // Try scrolling if not enough videos
  if (videos.length < 10) {
    await smartScroll(page);
    state = await extractTikTokData(page);
    const scrollVideos = mapVideoData(state);
    
    if (scrollVideos.length > videos.length) {
      videos = scrollVideos;
    } else {
      const domVideos = await extractFromDOM(page);
      if (domVideos.length > videos.length) {
        videos = domVideos;
      }
    }
  }
  
  return videos;
}

async function scrapeTopTrending(limit = CONFIG.LIMIT_DEFAULT) {
  const cacheKey = `trending_${limit}`;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    return cached;
  }
  
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const videos = await getExploreVideos(page, limit);
    
    const result = {
      videos: videos.slice(0, limit),
      metadata: {
        scraped_at: new Date().toISOString(),
        total_found: videos.length,
        returned: Math.min(videos.length, limit)
      }
    };
    
    cache.set(cacheKey, result);
    return result;
    
  } catch (error) {
    logger.error("Scraping failed:", error.message);
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// Routes
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "TikTok Trending Scraper",
    routes: ["/health", "/debug", "/trending"]
  });
});

app.get("/health", (_req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    cache_size: cache.size()
  });
});

app.get("/trending", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? CONFIG.LIMIT_DEFAULT, 10) || CONFIG.LIMIT_DEFAULT, 100);
    const result = await scrapeTopTrending(limit);
    res.json(result);
  } catch (error) {
    logger.error("API Error:", error.message);
    res.status(500).json({ 
      error: "scraping_failed", 
      message: error.message
    });
  }
});

app.get("/debug", async (req, res) => {
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const info = {
      url: CONFIG.BASE_EXPLORE,
      timestamp: new Date().toISOString(),
      browser_launched: true,
      page_loaded: false,
      has_data: false,
      video_links: 0
    };
    
    await page.goto(CONFIG.BASE_EXPLORE, { waitUntil: "domcontentloaded", timeout: CONFIG.REQUEST_TIMEOUT });
    info.page_loaded = true;
    info.page_title = await page.title();
    
    await acceptCookiesEverywhere(page);
    await page.waitForTimeout(2000);
    
    const state = await extractTikTokData(page);
    info.has_data = Boolean(state?.ItemModule || state?.itemModule);
    
    const videoLinks = await page.locator('a[href*="/video/"]').count();
    info.video_links = videoLinks;
    
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: "debug_failed", message: error.message });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

// Legacy endpoint
app.get("/top50", async (req, res) => {
  req.url = "/trending";
  app._router.handle(req, res);
});

// Error handling
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);
  res.status(500).json({ error: "internal_server_error" });
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Start server
const server = app.listen(CONFIG.PORT, () => {
  logger.info(`🚀 TikTok Scraper running on port ${CONFIG.PORT}`);
});

server.on('error', (error) => {
  logger.error('Server error:', error);
  process.exit(1);
});

export default app;
