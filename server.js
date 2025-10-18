const express = require('express');
const playwright = require('playwright');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 10000;

// Define storage path for Render's persistent disk
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, 'storage');
const CACHE_DIR = path.join(STORAGE_PATH, 'cache');

// Middleware
app.use(express.json());

// Polyfill for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure cache directory exists
async function ensureDirectories() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    console.log(`Created directory: ${CACHE_DIR}`);
  } catch (error) {
    console.error(`Failed to create directory ${CACHE_DIR}: ${error.message}`);
  }
}

// Run on startup
ensureDirectories().catch(error => console.error(`Directory setup failed: ${error.message}`));

// API endpoint: GET /api/album/:model/:index
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cachedData);
      if (images.length > 0) {
        console.log(`Serving ${images.length} cached images for ${model} at index ${index}`);
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache',
          cache_file: cacheFile
        });
      } else {
        console.log(`Empty cache for ${model} at index ${index}, forcing scrape...`);
        await fs.unlink(cacheFile).catch(() => {});
      }
    } catch (e) {
      console.log(`No valid cache for ${model} at index ${index}, scraping...`);
    }

    let imageUrls = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
        browser = await playwright.chromium.launch({
          headless: true,
          executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
            '--disable-features=IsolateOrigins,site-per-process',
            '--blink-settings=imagesEnabled=true'
          ],
          timeout: 90000
        });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
          }
        });
        if (process.env.PROXY_SERVER) {
          await context.setExtraHTTPHeaders({ 'Proxy-Server': process.env.PROXY_SERVER });
        }
        const page = await context.newPage();

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);

        let response;
        try {
          response = await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 90000 });
        } catch (navError) {
          console.error(`Navigation to ${searchUrl} failed: ${navError.message}`);
          throw navError;
        }

        if (response.status() === 404) {
          throw new Error(`Search page returned 404: ${searchUrl}`);
        }

        await delay(12000);

        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 200;
            const maxScrolls = 60;
            let scrollCount = 0;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              scrollCount++;
              if (totalHeight >= scrollHeight || scrollCount >= maxScrolls) {
                clearInterval(timer);
                resolve();
              }
            }, 200);
          });
        });

        await delay(12000);

        galleryLinks = await page.evaluate(() => {
          const links = [];
          const selectors = [
            'a[href*="/20"]',
            '.post-title a', '.entry-title a', 'h2 a', 'h3 a', '.post a',
            '.gallery a', 'a[href*="/gallery/"]', 'a[href*="/photo/"]',
            '.thumb a', '.image-link', '.post-thumbnail a', '.wp-block-gallery a',
            'a[href*="/tags/"]',
            'a[href*="ahottie.net"]'
          ];

          selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(a => {
              if (a.href && a.href.includes('ahottie.net') &&
                  !a.href.includes('/page/') &&
                  !a.href.includes('/search') &&
                  !a.href.includes('/?s=') &&
                  !a.href.includes('#')) {
                links.push(a.href);
              }
            });
          });

          return [...new Set(links)];
        });

        console.log(`Found ${galleryLinks.length} links for ${model}: ${galleryLinks.join(', ')}`);

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({
            error: `Invalid index ${index}. Must be between 1 and ${galleryLinks.length}.`,
            debug: {
              search_url: searchUrl,
              links_found: galleryLinks.length,
              links: galleryLinks
            }
          });
        }

        const galleryLink = galleryLinks[indexNum - 1];
        console.log(`Navigating to: ${galleryLink}`);
        try {
          response = await page.goto(galleryLink, { waitUntil: 'networkidle', timeout: 60000 });
        } catch (galleryError) {
          console.error(`Failed to navigate to ${galleryLink}: ${galleryError.message}`);
          throw galleryError;
        }

        if (response.status() === 404) {
          throw new Error(`Page returned 404: ${galleryLink}`);
        }

        await delay(12000);

        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });

        await delay(10000);

        imageUrls = await page.evaluate(() => {
          const images = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
          const urls = [];

          images.forEach(element => {
            let src;
            if (element.tagName.toLowerCase() === 'img') {
              src = element.src ||
                    element.getAttribute('data-src') ||
                    element.getAttribute('data-lazy-src') ||
                    element.getAttribute('data-original') ||
                    (element.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
            } else {
              const style = element.getAttribute('style');
              const match = style?.match(/background-image:\s?url\(['"]?(.+?)['"]?\)/i);
              src = match ? match[1] : null;
            }

            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
              const isRelevant = src.includes('ahottie.net') ||
                               src.includes('imgbox.com') ||
                               src.includes('wp-content');
              if (isRelevant) {
                urls.push(src);
              }
            }
          });

          return urls.slice(0, 50);
        });

        console.log(`Found ${imageUrls.length} images in ${galleryLink}`);

        // Fallback to search page if no images
        if (imageUrls.length === 0) {
          console.log(`No images in gallery, falling back to search page...`);
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
          await delay(12000);
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await delay(10000);

          imageUrls = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
            const urls = [];

            images.forEach(element => {
              let src;
              if (element.tagName.toLowerCase() === 'img') {
                src = element.src ||
                      element.getAttribute('data-src') ||
                      element.getAttribute('data-lazy-src') ||
                      element.getAttribute('data-original') ||
                      (element.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
              } else {
                const style = element.getAttribute('style');
                const match = style?.match(/background-image:\s?url\(['"]?(.+?)['"]?\)/i);
                src = match ? match[1] : null;
              }

              if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
                const isRelevant = src.includes('ahottie.net') ||
                                 src.includes('imgbox.com') ||
                                 src.includes('wp-content');
                if (isRelevant) {
                  urls.push(src);
                }
              }
            });

            return urls.slice(0, 50);
          });

          console.log(`Found ${imageUrls.length} images from fallback search page`);
        }

        await browser.close();
        browser = null;

      } catch (playwrightError) {
        console.error(`Playwright attempt ${attempts} failed for ${model} at index ${index}: ${playwrightError.message}`);
        if (browser) {
          await browser.close();
          browser = null;
        }
      }
    }

    if (imageUrls.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No images found for "${model}" at index ${index}.`,
        suggestion: `Try "Mia Nanasawa" or "LinXingLan". Visit https://ahottie.net/search?kw=${encodeURIComponent(model)} to confirm.`,
        debug: {
          search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`,
          gallery_url: galleryLinks[parseInt(index) - 1] || 'N/A',
          attempts_made: attempts,
          links_found: galleryLinks.length,
          links: galleryLinks
        }
      });
    }

    const images = imageUrls.map((url, idx) => {
      const fileExt = url.split('.').pop().split('?')[0] || 'jpg';
      return {
        id: idx + 1,
        name: `image_${idx + 1}.${fileExt}`,
        url,
        thumb: url
      };
    });

    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: 'ahottie.net',
      search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`,
      gallery_url: galleryLinks[parseInt(index) - 1] || 'N/A',
      cache_file: cacheFile
    });
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    console.error(`Error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).json({
      error: `Server error: ${error.message}`,
      debug: {
        search_url: `https://ahottie.net/search?kw=${encodeURIComponent(req.params.model)}`,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// API endpoint: GET /api/nsfw/:model/:index
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
      if (images.length === 0) {
        console.log(`Empty cache for ${model} at index ${index}`);
        return res.status(404).send(`
          <html>
            <head><title>Error</title></head>
            <body>
              <h1>Error</h1>
              <p>No images found in cache for ${model} at index ${index}.</p>
              <p>Run <a href="/api/album/${encodeURIComponent(model)}/${index}">/api/album/${encodeURIComponent(model)}/${index}</a> first.</p>
            </body>
          </html>
        `);
      }
    } catch (e) {
      console.log(`No cache file found for ${model} at index ${index}`);
      return res.status(404).send(`
        <html>
          <head><title>Error</title></head>
          <body>
            <h1>Error</h1>
            <p>No cached images for ${model} at index ${index}.</p>
            <p>Run <a href="/api/album/${encodeURIComponent(model)}/${index}">/api/album/${encodeURIComponent(model)}/${index}</a> first.</p>
          </body>
        </html>
      `);
    }

    const imageHtml = images.map(img => `
      <div style="margin-bottom: 20px;">
        <h3>${img.name}</h3>
        <img src="${img.url}" alt="${img.name}" style="max-width: 100%; height: auto; max-height: 600px;">
      </div>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>Images for ${model} (Index ${index})</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            h1 { color: #333; }
            h3 { margin: 10px 0 5px; }
            img { display: block; }
            a { color: #0066cc; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>Images for ${model} (Index ${index})</h1>
          <p>Total images: ${images.length}</p>
          <p><a href="/api/album/${encodeURIComponent(model)}/${index}">Refresh cache</a></p>
          ${imageHtml}
        </body>
      </html>
    `);
  } catch (error) {
    console.error(`NSFW endpoint error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Error</h1>
          <p>Server error: ${error.message}</p>
        </body>
      </html>
    `);
  }
});

// Health check
app.get('/', (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  res.send(`
    <html>
      <head>
        <title>Image Scraper API</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
          li { margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>Image Scraper API Ready</h1>
        <p>Using search URL: <code>https://ahottie.net/search?kw=modelname</code></p>
        
        <p>Endpoints:</p>
        <ul>
          <li><code>/api/album/cosplay/5</code> - Scrape images from 5th gallery and save to cache</li>
          <li><code>/api/nsfw/cosplay/5</code> - Display images from cache/cosplay/images_5.json</li>
        </ul>
        
        <p>Example Searches:</p>
        <ul>
          <li><a href="/api/album/cosplay/5" target="_blank">${baseUrl}/api/album/cosplay/5</a></li>
          <li><a href="/api/nsfw/cosplay/5" target="_blank">${baseUrl}/api/nsfw/cosplay/5</a></li>
          <li><a href="/api/album/horny/9" target="_blank">${baseUrl}/api/album/horny/9</a></li>
          <li><a href="/api/nsfw/horny/9" target="_blank">${baseUrl}/api/nsfw/horny/9</a></li>
        </ul>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using search URL: https://ahottie.net/search?kw=modelname`);
  console.log(`Health check: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
});
