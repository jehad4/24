const express = require('express');
const playwright = require('playwright');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 10000;

// Define storage path
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, 'storage');
const CACHE_DIR = path.join(STORAGE_PATH, 'cache');

// Middleware
app.use(express.json());

// Delay function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure cache directory exists
async function ensureDirectories() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory ${CACHE_DIR}: ${error.message}`);
  }
}

// Verify Chromium
async function verifyChromium() {
  try {
    await fs.access(process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium');
  } catch (error) {
    console.error(`Chromium not found: ${error.message}`);
  }
}

// Run on startup
ensureDirectories();
verifyChromium();

// API endpoint: GET /api/album/:model/:index
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

    // Check cache
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cachedData);
      if (images.length > 0) {
        return res.json({ model, index, album: images, total: images.length, source: 'cache' });
      }
    } catch (e) {
      console.log(`No cache for ${model} at index ${index}, scraping...`);
    }

    let imageData = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && imageData.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
        browser = await playwright.chromium.launch({ headless: true, timeout: 90000 });
        const page = await browser.newPage();

        // Navigate to search page
        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 00000 });

        // Simple scroll
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(5000);

        // Collect gallery links
        galleryLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="/albums/"]').forEach(a => {
            if (a.href.includes('ahottie.net') && a.querySelector('img')) {
              links.push(a.href);
            }
          });
          return links.slice(0, 10); // Limit to 10 links
        });

        if (galleryLinks.length === 0) {
          throw new Error(`No gallery links found for ${model}`);
        }

        const indexNum = parseInt(index, 10) - 1;
        if (indexNum < 0 || indexNum >= galleryLinks.length) {
          throw new Error(`Invalid index ${index}. Must be between 1 and ${galleryLinks.length}`);
        }

        // Navigate to gallery
        const galleryLink = galleryLinks[indexNum];
        console.log(`Navigating to gallery: ${galleryLink}`);
        await page.goto(galleryLink, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await delay(5000);

        // Collect images
        imageData = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll('a[href], img').forEach(el => {
            const href = el.href || el.src;
            if (href && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(href)) {
              items.push({ url: href, thumb: href });
            }
          });
          return items.slice(0, 20); // Limit to 20 images
        });

        await browser.close();
        browser = null;

      } catch (error) {
        console.error(`Playwright attempt ${attempts} failed: ${error.message}`);
        if (browser) await browser.close();
      }
    }

    if (imageData.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No images found for "${model}" at index ${index}.`,
        suggestion: `Try a different model or index.`
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
      gallery_url: galleryLinks[indexNum]
    });
  } catch (error) {
    if (browser) await browser.close();
    console.error(`Error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).json({ error: `Server error: ${error.message}` });
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
      return res.status(404).send(`<html><body><h1>Error</h1><p>No images in cache. Run /api/album/${encodeURIComponent(model)}/${index} first.</p></body></html>`);
    }

    const imageHtml = images.map(img => `
      <div><h3>${img.name}</h3><img src="${img.url}" alt="${img.name}" style="max-width:100%;max-height:600px;"></div>
    `).join('');
    res.send(`
      <html><head><title>Images for ${model}</title><style>body{margin:40px;font-family:Arial;}</style></head>
      <body><h1>Images for ${model} (Index ${index})</h1><p>Total: ${images.length}</p>${imageHtml}</body></html>
    `);
  } catch (error) {
    res.status(500).send(`<html><body><h1>Error</h1><p>Server error: ${error.message}</p></body></html>`);
  }
});

// Health check
app.get('/', (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  res.send(`
    <html><head><title>Image Scraper API</title><style>body{margin:40px;font-family:Arial;}</style></head>
    <body><h1>Image Scraper API Ready</h1><p>Try: <a href="${baseUrl}/api/album/cosplay/1" target="_blank">${baseUrl}/api/album/cosplay/1</a></p></body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
});
