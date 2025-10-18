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

// Verify Chromium executable
async function verifyChromium() {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium';
  try {
    await fs.access(executablePath);
    console.log(`Chromium found at ${executablePath}`);
  } catch (error) {
    console.error(`Chromium not found at ${executablePath}: ${error.message}`);
  }
}

// Run on startup
ensureDirectories().catch(error => console.error(`Directory setup failed: ${error.message}`));
verifyChromium().catch(error => console.error(`Chromium verification failed: ${error.message}`));

// API endpoint: GET /api/album/:model/:index
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

    // Check cache for instant response
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cachedData);
      if (images.length > 0) {
        console.log(`Serving ${images.length} cached images for ${model} at index ${index} [FAST]`);
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache',
          cache_file: cacheFile
        });
      }
    } catch (e) {
      console.log(`No valid cache for ${model} at index ${index}, scraping...`);
    }

    let imageData = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 2; // Reduced for speed

    while (attempts < maxAttempts && imageData.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
        browser = await playwright.chromium.launch({
          headless: true,
          executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
            '--disable-features=IsolateOrigins,site-per-process',
            '--blink-settings=imagesEnabled=false' // Disable image loading for speed
          ],
          timeout: 30000 // Reduced timeout
        });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        if (process.env.PROXY_SERVER) {
          await context.setExtraHTTPHeaders({ 'Proxy-Server': process.env.PROXY_SERVER });
        }
        const page = await context.newPage();

        // Navigate to search page
        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (response.status() === 404) {
          throw new Error(`Search page returned 404: ${searchUrl}`);
        }

        // Minimal scroll to load initial content
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await delay(5000); // Reduced delay

        // Collect gallery links matching the provided inspect pattern
        galleryLinks = await page.evaluate(() => {
          const links = [];
          const galleryElements = document.querySelectorAll('a[href*="/albums/"]');
          galleryElements.forEach(a => {
            if (a.href.includes('ahottie.net') && a.querySelector('img') && a.querySelector('time')) {
              links.push(a.href);
            }
          });
          // Shuffle links randomly
          for (let i = links.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [links[i], links[j]] = [links[j], links[i]];
          }
          return [...new Set(links)].slice(0, 10); // Limit to 10 links
        });

        console.log(`Found ${galleryLinks.length} gallery links for ${model}`);

        if (galleryLinks.length === 0) {
          throw new Error(`No gallery links found for ${model}`);
        }

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({
            error: `Invalid index ${index}. Must be between 1 and ${galleryLinks.length}.`,
            debug: { search_url: searchUrl, links_found: galleryLinks.length }
          });
        }

        // Navigate to the specific gallery link
        const galleryLink = galleryLinks[indexNum - 1];
        console.log(`Navigating to gallery: ${galleryLink}`);
        await page.goto(galleryLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await delay(3000); // Reduced delay

        // Minimal scroll in gallery
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await delay(2000);

        // Collect image links from gallery
        imageData = await page.evaluate(() => {
          const items = [];
          const anchors = document.querySelectorAll('a[href]');
          anchors.forEach(a => {
            const href = a.href;
            if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(href)) {
              items.push({ url: href, thumb: href });
            }
          });
          const images = document.querySelectorAll('img');
          images.forEach(img => {
            const src = img.src || img.getAttribute('data-src');
            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
              items.push({ url: src, thumb: src });
            }
          });
          return [...new Set(items.map(item => JSON.stringify(item)))].map(str => JSON.parse(str)).slice(0, 20);
        });

        console.log(`Found ${imageData.length} images in ${galleryLink}`);

        await browser.close();
        browser = null;

      } catch (playwrightError) {
        console.error(`Playwright attempt ${attempts} failed: ${playwrightError.message}`);
        if (browser) await browser.close();
      }
    }

    if (imageData.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No images found for "${model}" at index ${index}.`,
        suggestion: `Try adjusting the model name or index. Visit ${searchUrl} to confirm.`,
        debug: { search_url: searchUrl, gallery_url: galleryLinks[indexNum - 1] || 'N/A' }
      });
    }

    // Format and cache
    const images = imageData.map((data, idx) => ({
      id: idx + 1,
      name: `image_${idx + 1}.${data.url.split('.').pop().split('?')[0] || 'jpg'}`,
      url: data.url,
      thumb: data.thumb
    }));
    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: 'ahottie.net',
      search_url: searchUrl,
      gallery_url: galleryLinks[indexNum - 1],
      cache_file: cacheFile
    });
  } catch (error) {
    if (browser) await browser.close();
    console.error(`Error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).json({ error: `Server error: ${error.message}`, debug: { timestamp: new Date().toISOString() } });
  }
});

// API endpoint: GET /api/nsfw/:model/:index
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(CACHE_DIR, model, `images_${index}.json`);
    const cachedData = await fs.readFile(cacheFile, 'utf8');
    const images = JSON.parse(cachedData);

    if (images.length === 0) {
      return res.status(404).send(`
        <html><body><h1>Error</h1><p>No images in cache. Run /api/album/${encodeURIComponent(model)}/${index} first.</p></body></html>
      `);
    }

    const imageHtml = images.map(img => `
      <div><h3>${img.name}</h3><img src="${img.url}" alt="${img.name}" style="max-width:100%;max-height:600px;"></div>
    `).join('');
    res.send(`
      <html><head><title>Images for ${model}</title><style>body{margin:40px;font-family:Arial;}img{display:block;}</style></head>
      <body><h1>Images for ${model} (Index ${index})</h1><p>Total: ${images.length}</p>${imageHtml}</body></html>
    `);
  } catch (error) {
    res.status(500).send(`<html><body><h1>Error</h1><p>Server error: ${error.message}</p></body></html>`);
  }
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    await fs.access(process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium');
    res.send('Chromium found');
  } catch (error) {
    res.send(`Chromium not found: ${error.message}`);
  }
});

// Health check
app.get('/', (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  res.send(`
    <html><head><title>Image Scraper API</title><style>body{margin:40px;font-family:Arial;}</style></head>
    <body><h1>Image Scraper API Ready</h1><p>Endpoints: /api/album/rika_aimi/1, /api/nsfw/rika_aimi/1, /debug</p>
    <p>Examples: <a href="${baseUrl}/api/album/rika_aimi/1" target="_blank">${baseUrl}/api/album/rika_aimi/1</a></p></body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
});
