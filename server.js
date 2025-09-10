// server.js - Versione completa con mobile strategy
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
  BASE_EXPLORE: "https://www.tiktok.com/@tiktok", // Profilo ufficiale
  VIEWPORT: { width: 414, height: 896 }, // Mobile viewport
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 60000, // Timeout più lungo
  
  // Mobile User Agent (meno rilevato)
  USER_AGENT: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
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

// TikTok URLs to try
const TIKTOK_URLS = [
  "https://www.tiktok.com/@tiktok", // Profilo ufficiale TikTok
  "https://www.tiktok.com/@charlidamelio", // Creator popolare
  "https://www.tiktok.com/@khaby.lame", // Creator globale
  "https://www.tiktok.com/@mrbeast", // Creator con molti video
  "https://www.tiktok.com/foryou?lang=en",
  "https://www.tiktok.com/explore?lang=en"
];

// Browser context ottimizzato per mobile
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
        "--user-agent=" + CONFIG.USER_AGENT,
        // Mobile-specific args
        "--enable-touch-events",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run"
      ],
    });

    const context = await browser.newContext({
      viewport: CONFIG.VIEWPORT,
      userAgent: CONFIG.USER_AGENT,
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { latitude: 40.7128, longitude: -74.0060 },
      permissions: ["geolocation"],
      hasTouch: true, // Mobile touch
      isMobile: true, // Mobile flag
      deviceScaleFactor: 2,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    // Anti-detection scripts
    await context.addInitScript(() => {
      // Remove webdriver traces
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      
      // Mock mobile features
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
      Object.defineProperty(navigator, 'ontouchstart', { get: () => true });
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    return { browser, context };
  } catch (error) {
    logger.error("Failed to create browser context:", error.message);
    if (retries < CONFIG.MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 3000 * (retries + 1)));
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
    'button:has-text("Allow all")',
    '[data-e2e="cookie-banner-ok"]',
    '.cookie-banner button'
  ];

  for (const selector of cookieSelectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
        await element.click({ delay: 100 });
        await page.waitForTimeout(500);
        logger.debug("Accepted cookies");
        return true;
      }
    } catch (e) {
      // Continue
    }
  }
  return false;
}

async function smartScroll(page, options = {}) {
  const { steps = 5, waitMs = 3000 } = options;
  
  for (let i = 0; i < steps; i++) {
    // Mobile-style scrolling
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(waitMs + Math.random() * 1000);
  }
}

// Extract hashtags from text
function extractHashtags(text = "") {
  if (!text) return [];
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(matches)].slice(0, 10);
}

// Extract views from text
function extractViews(text) {
  const matches = text.match(/(\d+(?:\.\d+)?)\s*([KMB]?)\s*views?/i);
  if (!matches) return 0;
  
  const [, number, unit] = matches;
  let views = parseFloat(number);
  
  switch (unit?.toUpperCase()) {
    case 'K': views *= 1000; break;
    case 'M': views *= 1000000; break;
    case 'B': views *= 1000000000; break;
  }
  
  return Math.floor(views);
}

// Data extraction from JSON
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
          /"ItemModule":\s*({.+?})/s,
          /"itemModule":\s*({.+?})/s
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

// Extract from DOM fallback
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

// Extract from profile pages
async function extractFromProfile(page) {
  return await page.evaluate(() => {
    const videos = [];
    
    // Selettori per video nei profili
    const videoSelectors = [
      'a[href*="/video/"]',
      '[data-e2e="user-post-item"] a',
      '.video-feed-item a',
      '[class*="video"] a[href*="/video/"]',
      '[data-e2e="user-post-item-video"] a'
    ];
    
    for (const selector of videoSelectors) {
      const links = document.querySelectorAll(selector);
      console.log(`Found ${links.length} links with selector: ${selector}`);
      
      for (const link of links) {
        try {
          const href = link.href;
          if (!href || !href.includes('/video/')) continue;
          
          const match = href.match(/\/@([^/]+)\/video\/(\d+)/);
          if (!match) continue;
          
          const [, username, videoId] = match;
          
          // Try to extract additional info from parent elements
          const container = link.closest('[data-e2e="user-post-item"]') || 
                           link.closest('.video-item') || 
                           link.closest('[class*="item"]') || 
                           link.parentElement;
          
          const img = container?.querySelector('img');
          const textContent = container?.textContent || '';
          
          // Extract views from text if available
          const views = extractViews(textContent);
          
          videos.push({
            video_id: videoId,
            video_url: href,
            author_username: username,
            caption: img?.alt || '',
            hashtags: extractHashtags(img?.alt || ''),
            thumbnail_url: img?.src || '',
            views: views,
            likes: 0,
            comments: 0,
            shares: 0,
            published_at: new Date().toISOString(),
            source: 'profile_extraction'
          });
          
        } catch (e) {
          continue;
        }
      }
      
      if (videos.length > 0) break;
    }
    
    return videos;
  });
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
           Math.max(item.stats.playCount, 1) * 100).toFixed(2) : 0,
        source: 'JSON_extraction'
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

// Main scraping function
async function getExploreVideos(page, minVideos = 50) {
  const allVideos = [];
  
  for (const url of TIKTOK_URLS) {
    try {
      logger.info(`🔍 Trying URL: ${url}`);
      
      await page.goto(url, { 
        waitUntil: "networkidle", 
        timeout: CONFIG.REQUEST_TIMEOUT 
      });
      
      // Wait longer for mobile content
      await page.waitForTimeout(8000);
      
      await acceptCookiesEverywhere(page);
      await page.waitForTimeout(2000);
      
      // Check for blocks/challenges
      const title = await page.title();
      const urlCheck = page.url();
      
      if (title.includes('verify') || title.includes('challenge') || 
          urlCheck.includes('challenge') || urlCheck.includes('captcha')) {
        logger.warn(`❌ Challenge detected on ${url}`);
        continue;
      }
      
      let videos = [];
      
      // Strategy 1: Profile extraction (for profile URLs)
      if (url.includes('/@')) {
        videos = await extractFromProfile(page);
        logger.info(`📱 Profile extraction: ${videos.length} videos`);
      }
      
      // Strategy 2: Standard JSON extraction
      if (videos.length === 0) {
        const state = await extractTikTokData(page);
        videos = mapVideoData(state);
        logger.info(`📄 JSON extraction: ${videos.length} videos`);
      }
      
      // Strategy 3: DOM extraction
      if (videos.length === 0) {
        videos = await extractFromDOM(page);
        logger.info(`🌐 DOM extraction: ${videos.length} videos`);
      }
      
      // Strategy 4: Scroll and retry
      if (videos.length < 5) {
        logger.info(`🔄 Scrolling for more content...`);
        
        // Mobile-style scrolling
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
          await page.waitForTimeout(3000);
        }
        
        // Try extraction again after scroll
        if (url.includes('/@')) {
          const scrollVideos = await extractFromProfile(page);
          if (scrollVideos.length > videos.length) videos = scrollVideos;
        } else {
          const state = await extractTikTokData(page);
          const scrollVideos = mapVideoData(state);
          if (scrollVideos.length > videos.length) videos = scrollVideos;
        }
      }
      
      if (videos.length > 0) {
        allVideos.push(...videos);
        logger.info(`✅ Success with ${url}: ${videos.length} videos`);
        
        // If we have enough videos, stop
        if (allVideos.length >= 20) break;
      }
      
      // Small delay between URLs
      await page.waitForTimeout(2000);
      
    } catch (error) {
      logger.warn(`❌ Error with ${url}:`, error.message);
      continue;
    }
  }
  
  // Remove duplicates by video_id
  const uniqueVideos = allVideos.filter((video, index, self) => 
    index === self.findIndex(v => v.video_id === video.video_id)
  );
  
  logger.info(`🎯 Total unique videos found: ${uniqueVideos.length}`);
  return uniqueVideos;
}

async function scrapeTopTrending(limit = CONFIG.LIMIT_DEFAULT) {
  const cacheKey = `trending_${limit}`;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    logger.info("Returning cached results");
    return cached;
  }
  
  logger.info(`Starting scrape for top ${limit} trending videos`);
  
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const videos = await getExploreVideos(page, limit);
    
    // Sort by engagement if we have stats
    const sortedVideos = videos
      .filter(video => video && video.video_url && video.video_id)
      .sort((a, b) => {
        const engagementA = a.likes + a.comments + a.shares + (a.views || 0) / 100;
        const engagementB = b.likes + b.comments + b.shares + (b.views || 0) / 100;
        return engagementB - engagementA;
      })
      .slice(0, limit);
    
    const result = {
      videos: sortedVideos,
      metadata: {
        scraped_at: new Date().toISOString(),
        total_found: videos.length,
        returned: sortedVideos.length,
        sources_used: [...new Set(videos.map(v => v.source))]
      }
    };
    
    cache.set(cacheKey, result);
    logger.info(`Scraping completed. Found ${sortedVideos.length} videos`);
    
    return result;
    
  } catch (error) {
    logger.error("Scraping failed:", error.message);
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// API Routes
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "TikTok Trending Scraper",
    version: "3.0.0",
    routes: [
      "GET /health - Health check",
      "GET /debug - Debug info", 
      "GET /trending - Get trending videos",
      "GET /test - Test extraction",
      "GET /stats - Cache statistics"
    ]
  });
});

app.get("/health", (_req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    cache_size: cache.size(),
    uptime: process.uptime()
  });
});

app.get("/trending", async (req, res) => {
  try {
    const limit = Math.min(
      parseInt(req.query.limit ?? CONFIG.LIMIT_DEFAULT, 10) || CONFIG.LIMIT_DEFAULT, 
      100
    );
    
    const result = await scrapeTopTrending(limit);
    res.json(result);
    
  } catch (error) {
    logger.error("API Error:", error.message);
    res.status(500).json({ 
      error: "scraping_failed", 
      message: error.message,
      timestamp: new Date().toISOString()
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
      video_links: 0,
      user_agent: CONFIG.USER_AGENT,
      viewport: CONFIG.VIEWPORT
    };
    
    try {
      await page.goto(CONFIG.BASE_EXPLORE, { 
        waitUntil: "domcontentloaded", 
        timeout: CONFIG.REQUEST_TIMEOUT 
      });
      info.page_loaded = true;
      info.page_title = await page.title();
      info.final_url = page.url();
      
      await acceptCookiesEverywhere(page);
      await page.waitForTimeout(3000);
      
      const state = await extractTikTokData(page);
      info.has_data = Boolean(state?.ItemModule || state?.itemModule);
      
      const videoLinks = await page.locator('a[href*="/video/"]').count();
      info.video_links = videoLinks;
      
      // Try profile extraction
      const profileVideos = await extractFromProfile(page);
      info.profile_videos = profileVideos.length;
      info.sample_video = profileVideos[0] || null;
      
    } catch (e) {
      info.error = e.message;
    }
    
    res.json(info);
    
  } catch (error) {
    res.status(500).json({ 
      error: "debug_failed", 
      message: error.message 
    });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/test", async (req, res) => {
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const testUrl = req.query.url || "https://www.tiktok.com/@tiktok";
    await page.goto(testUrl, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(5000);
    
    const info = {
      url: testUrl,
      title: await page.title(),
      final_url: page.url(),
      video_links: await page.locator('a[href*="/video/"]').count(),
      has_challenge: page.url().includes('challenge'),
      viewport: await page.viewportSize(),
      user_agent: await page.evaluate(() => navigator.userAgent)
    };
    
    // Try extraction
    const videos = await extractFromProfile(page);
    info.videos_found = videos.length;
    info.sample_videos = videos.slice(0, 3);
    
    res.json(info);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/stats", (req, res) => {
  res.json({
    cache: {
      size: cache.size(),
      ttl_minutes: CONFIG.CACHE_TTL_MS / 60000
    },
    config: {
      headless: CONFIG.HEADLESS,
      default_limit: CONFIG.LIMIT_DEFAULT,
      user_agent: CONFIG.USER_AGENT.slice(0, 50) + "...",
      viewport: CONFIG.VIEWPORT,
      urls_to_try: TIKTOK_URLS.length
    },
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      node_version: process.version
    }
  });
});

// Legacy endpoint compatibility
app.get("/top50", async (req, res) => {
  logger.warn("Using deprecated endpoint /top50, use /trending instead");
  req.url = "/trending";
  return app._router.handle(req, res);
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);
  res.status(500).json({
    error: "internal_server_error",
    message: "An unexpected error occurred"
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully'); 
  process.exit(0);
});

// Start server
const server = app.listen(CONFIG.PORT, () => {
  logger.info(`🚀 TikTok Scraper v3.0 running on port ${CONFIG.PORT}`);
  logger.info(`📱 Using mobile strategy with iPhone User-Agent`);
  logger.info(`🔗 Health: http://localhost:${CONFIG.PORT}/health`);
  logger.info(`🧪 Test: http://localhost:${CONFIG.PORT}/test`);
  logger.info(`🎯 API: http://localhost:${CONFIG.PORT}/trending`);
});

server.on('error', (error) => {
  logger.error('Server error:', error);
  process.exit(1);
});

export default app;
