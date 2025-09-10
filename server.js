// SOSTITUZIONE COMPLETA della funzione extractTikTokData nel server.js

async function extractTikTokData(page) {
  return await page.evaluate(() => {
    let state = null;
    
    // Strategy 1: Multiple window objects
    const windowObjects = ['__INITIAL_STATE__', 'SIGI_STATE', '__NEXT_DATA__', '__APP_CONTEXT__'];
    for (const obj of windowObjects) {
      if (window[obj]) {
        console.log(`Found window.${obj}`);
        state = window[obj];
        break;
      }
    }
    
    // Strategy 2: Script tags with different selectors
    if (!state) {
      const scriptSelectors = [
        'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]',
        'script[type="application/json"]',
        'script[data-sentry-component="App"]',
        'script:not([src]):not([type])'
      ];
      
      for (const selector of scriptSelectors) {
        const scripts = document.querySelectorAll(selector);
        for (const script of scripts) {
          try {
            const text = script.textContent || script.innerText;
            if (text.includes('ItemModule') || text.includes('itemModule') || text.includes('VideoModule')) {
              console.log(`Found data in script with selector: ${selector}`);
              state = JSON.parse(text);
              break;
            }
          } catch (e) {
            continue;
          }
        }
        if (state) break;
      }
    }
    
    // Strategy 3: All scripts search with multiple patterns
    if (!state) {
      const scripts = Array.from(document.scripts);
      const patterns = [
        /window\.__INITIAL_STATE__\s*=\s*({.+?});/s,
        /window\.SIGI_STATE\s*=\s*({.+?});/s,
        /__INITIAL_STATE__["']?\s*[:=]\s*({.+?})[,;]/s,
        /"props":\s*({.+?"pageProps".+?})/s,
        /"ItemModule":\s*({.+?}),/s,
        /"itemModule":\s*({.+?})/s
      ];
      
      for (const script of scripts) {
        const text = script.textContent || '';
        if (text.length < 1000) continue; // Skip small scripts
        
        for (const pattern of patterns) {
          try {
            const match = text.match(pattern);
            if (match && match[1]) {
              console.log('Found match with pattern:', pattern.source.slice(0, 50));
              const parsed = JSON.parse(match[1]);
              
              // Validate that it contains video data
              if (parsed.ItemModule || parsed.itemModule || 
                  (parsed.props && parsed.props.pageProps) ||
                  parsed.videoModule || parsed.VideoModule) {
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
    
    // Strategy 4: Look for any object with video-like data
    if (!state) {
      const scripts = Array.from(document.scripts);
      for (const script of scripts) {
        const text = script.textContent || '';
        
        // Look for common TikTok video properties
        if (text.includes('"author"') && text.includes('"video"') && 
            text.includes('"stats"') && text.includes('"playCount"')) {
          
          try {
            // Try to extract the largest JSON object
            const jsonMatches = text.match(/{[^{}]*"author"[^{}]*"video"[^{}]*}/g);
            if (jsonMatches && jsonMatches.length > 0) {
              const largestJson = jsonMatches.reduce((a, b) => a.length > b.length ? a : b);
              console.log('Found video data in raw script');
              
              // Wrap in a structure similar to ItemModule
              state = {
                ItemModule: {
                  'extracted_video': JSON.parse(largestJson)
                }
              };
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }
    }
    
    // Debug output
    if (state) {
      const keys = Object.keys(state);
      console.log('Final state keys:', keys);
      
      // Count potential videos
      let videoCount = 0;
      if (state.ItemModule) videoCount = Object.keys(state.ItemModule).length;
      else if (state.itemModule) videoCount = Object.keys(state.itemModule).length;
      else if (state.props?.pageProps?.itemModule) videoCount = Object.keys(state.props.pageProps.itemModule).length;
      
      console.log('Potential video count:', videoCount);
    } else {
      console.log('No state found. Debugging page content...');
      console.log('Page title:', document.title);
      console.log('URL:', window.location.href);
      console.log('Scripts count:', document.scripts.length);
      
      // Check if there are any obvious video containers
      const videoContainers = document.querySelectorAll('[data-e2e="recommend-list-item"], .video-feed-item, [class*="video"], [class*="item"]');
      console.log('Video-like containers found:', videoContainers.length);
      
      // Look for any data attributes
      const dataElements = document.querySelectorAll('[data-*]');
      console.log('Elements with data attributes:', dataElements.length);
    }
    
    return state;
  });
}

// NUOVA funzione per estrarre dati direttamente dal DOM se JSON fallisce
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const videos = [];
    
    // Multiple selectors for video items
    const selectors = [
      '[data-e2e="recommend-list-item"]',
      '.video-feed-item', 
      '[class*="DivItemContainer"]',
      '[class*="ItemContainer"]',
      'a[href*="/video/"]'
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      console.log(`Found ${elements.length} elements with selector: ${selector}`);
      
      for (const el of elements) {
        try {
          // Extract video URL
          const videoLink = el.querySelector('a[href*="/video/"]') || el;
          const href = videoLink.href || videoLink.getAttribute('href');
          
          if (!href || !href.includes('/video/')) continue;
          
          // Extract basic info from DOM
          const textContent = el.textContent || '';
          const captionEl = el.querySelector('[data-e2e="video-desc"], .video-meta-caption, [class*="caption"]');
          const authorEl = el.querySelector('[data-e2e="video-author"], .author-name, [class*="author"]');
          
          const video = {
            video_id: href.match(/\/video\/(\d+)/)?.[1] || Date.now().toString(),
            video_url: href,
            author_username: authorEl?.textContent?.trim().replace('@', '') || 'unknown',
            caption: captionEl?.textContent?.trim() || '',
            hashtags: extractHashtags(captionEl?.textContent || ''),
            views: 0,
            likes: 0,
            comments: 0,
            shares: 0,
            published_at: new Date().toISOString(),
            source: 'DOM_extraction'
          };
          
          videos.push(video);
          
        } catch (e) {
          continue;
        }
      }
      
      if (videos.length > 0) break; // Stop at first successful selector
    }
    
    return videos;
  });
}

// AGGIORNA la funzione getExploreVideos per usare entrambe le strategie
async function getExploreVideos(page, minVideos = 60) {
  logger.info("Starting explore page scraping...");
  
  await page.goto(CONFIG.BASE_EXPLORE, { 
    waitUntil: "domcontentloaded", 
    timeout: CONFIG.REQUEST_TIMEOUT 
  });
  
  await acceptCookiesEverywhere(page);
  await page.waitForTimeout(3000); // Wait for dynamic content
  
  // Strategy 1: Try JSON extraction
  let state = await extractTikTokData(page);
  let videos = mapVideoData(state);
  
  logger.info(`JSON extraction found ${videos.length} videos`);
  
  // Strategy 2: If JSON fails, try DOM extraction
  if (videos.length === 0) {
    logger.info("JSON extraction failed, trying DOM extraction...");
    videos = await extractFromDOM(page);
    logger.info(`DOM extraction found ${videos.length} videos`);
  }
  
  // Strategy 3: If still no videos, scroll and try again
  if (videos.length < minVideos) {
    logger.info("Scrolling to load more content...");
    await smartScroll(page, { steps: 8, waitMs: 2000 });
    
    // Try JSON again after scroll
    state = await extractTikTokData(page);
    const scrollVideos = mapVideoData(state);
    
    if (scrollVideos.length > videos.length) {
      videos = scrollVideos;
      logger.info(`After scroll JSON: ${videos.length} videos`);
    } else {
      // Try DOM again after scroll
      const domVideos = await extractFromDOM(page);
      if (domVideos.length > videos.length) {
        videos = domVideos;
        logger.info(`After scroll DOM: ${videos.length} videos`);
      }
    }
  }
  
  return videos;
}

// AGGIORNA mapVideoData per gestire strutture diverse
function mapVideoData(state) {
  if (!state) return [];
  
  let items = [];
  
  // Try different paths
  if (state.ItemModule) {
    items = Object.values(state.ItemModule);
  } else if (state.itemModule) {
    items = Object.values(state.itemModule);
  } else if (state.props?.pageProps?.itemModule) {
    items = Object.values(state.props.pageProps.itemModule);
  } else if (state.props?.pageProps?.items) {
    items = state.props.pageProps.items;
  } else if (Array.isArray(state)) {
    items = state;
  }
  
  return items.map(item => {
    try {
      // Handle different item structures
      const videoInfo = item.video || item;
      const statsInfo = item.stats || {};
      const authorInfo = item.author || item.authorName || 'unknown';
      
      return {
        video_id: item.id || videoInfo.id || Date.now().toString(),
        video_url: `https://www.tiktok.com/@${authorInfo}/video/${item.id || videoInfo.id}`,
        author_username: authorInfo,
        author_display_name: item.authorName || item.author || authorInfo,
        caption: item.desc || item.caption || "",
        hashtags: extractHashtags(item.desc || item.caption || ""),
        sound_title: item.music?.title || "",
        sound_artist: item.music?.authorName || item.music?.author || "",
        views: statsInfo.playCount || 0,
        likes: statsInfo.diggCount || 0,
        comments: statsInfo.commentCount || 0,
        shares: statsInfo.shareCount || 0,
        duration_sec: videoInfo.duration || null,
        published_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null,
        thumbnail_url: videoInfo.cover || videoInfo.originCover || null,
        engagement_rate: statsInfo.playCount ? 
          ((statsInfo.diggCount + statsInfo.commentCount + statsInfo.shareCount) / 
           Math.max(statsInfo.playCount, 1) * 100).toFixed(2) : 0
      };
    } catch (e) {
      logger.warn("Error mapping video data:", e.message);
      return null;
    }
  }).filter(Boolean);
}
