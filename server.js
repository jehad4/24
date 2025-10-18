const express = require('express');
const playwright = require('playwright');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 10000;
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, 'storage');
const CACHE_DIR = path.join(STORAGE_PATH, 'cache');
app.use(express.json());
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureDirectories() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    console.log(`Created directory: ${CACHE_DIR}`);
  } catch (error) {
    console.error(`Failed to create directory ${CACHE_DIR}: ${error.message}`);
    throw error;
  }
}

async function verifyChromium() {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium';
  try {
    await fs.access(executablePath);
    console.log(`Chromium found at ${executablePath}`);
    return executablePath;
  } catch (error) {
    console.error(`Chromium not found at ${executablePath}: ${error.message}`);
    throw error;
  }
}

// Function to remove duplicate images
function removeDuplicateImages(images) {
  const seen = new Set();
  const uniqueImages = [];
  
  for (const image of images) {
    // Normalize URLs by removing query parameters and fragments
    const normalizedUrl = image.url.split('?')[0].split('#')[0];
    const normalizedThumb = image.thumb.split('?')[0].split('#')[0];
    
    // Create a unique key using both URL and thumbnail
    const key = `${normalizedUrl}|${normalizedThumb}`;
    
    if (!seen.has(key)) {
      seen.add(key);
      uniqueImages.push(image);
    }
  }
  
  console.log(`Removed ${images.length - uniqueImages.length} duplicate images`);
  return uniqueImages;
}

ensureDirectories().catch(error => console.error(`Directory setup failed: ${error.message}`));
verifyChromium().catch(error => console.error(`Chromium verification failed: ${error.message}`));

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
        console.log(`Serving ${images.length} cached images for ${model} at index ${index}`);
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache',
          cache_file: cacheFile,
          cached_at: (await fs.stat(cacheFile)).mtime.toISOString()
        });
      }
      console.log(`Empty cache for ${model} at index ${index}, scraping...`);
      await fs.unlink(cacheFile).catch(() => {});
    } catch (e) {
      console.log(`No valid cache for ${model} at index ${index}, scraping...`);
    }

    let imageData = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 2;
    const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;

    while (attempts < maxAttempts && imageData.length === 0) {
      attempts++;
      console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
      try {
        const executablePath = await verifyChromium();
        browser = await playwright.chromium.launch({
          headless: true,
          executablePath,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-background-timer-throttling',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
          ],
          timeout: 60000
        });

        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
        });

        // Block images, fonts, stylesheets for faster loading
        await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico}', route => route.abort());
        await context.route('**/*.{woff,woff2,eot,ttf}', route => route.abort());
        await context.route('**/*.css', route => route.abort());

        const page = await context.newPage();

        // Navigate to search page
        console.log(`Navigating to: ${searchUrl}`);
        const response = await page.goto(searchUrl, { 
          waitUntil: 'domcontentloaded', 
          timeout: 90000 
        });
        
        if (!response || response.status() === 404) {
          throw new Error(`Search page returned ${response ? response.status() : 'no response'}: ${searchUrl}`);
        }

        // Wait for content with shorter timeout
        await page.waitForSelector('body', { timeout: 15000 }).catch(() => console.log('Body selector timeout, proceeding...'));

        // Fast scroll - reduced iterations
        await page.evaluate(async () => {
          await new Promise(resolve => {
            let totalHeight = 0;
            const distance = 300; // Increased scroll distance
            const maxScrolls = 15; // Reduced from 30 to 15
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
            }, 50); // Faster interval
          });
        });

        // Collect gallery links - optimized selector
        galleryLinks = await page.evaluate(() => {
          const links = new Set();
          // Focus on most common selectors first
          const selectors = [
            'a[href*="/albums/"]',
            'a[href*="/gallery/"]',
            '.post-title a',
            '.entry-title a',
            'h2 a',
            '.gallery a',
            '.thumb a'
          ];
          
          selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            for (let i = 0; i < elements.length; i++) {
              const a = elements[i];
              const href = a.href;
              if (href && 
                  href.includes('ahottie.net') &&
                  !href.includes('/page/') &&
                  !href.includes('/search') &&
                  !href.includes('/?s=') &&
                  !href.includes('#') &&
                  !href.includes('/tags/') &&
                  a.querySelector('img')) {
                links.add(href);
              }
            }
          });
          
          return Array.from(links).slice(0, 10);
        });

        console.log(`Found ${galleryLinks.length} gallery links for ${model}`);
        if (galleryLinks.length === 0) {
          throw new Error(`No gallery links found for ${model}`);
        }

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          throw new Error(`Invalid index ${index}. Must be between 1 and ${galleryLinks.length}`);
        }

        // Navigate to gallery
        const baseGalleryLink = galleryLinks[indexNum - 1];
        console.log(`Base gallery URL: ${baseGalleryLink}`);
        const maxPages = 5; // RESTORED to 5 pages as you requested

        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
          const galleryLink = pageNum === 1 ? baseGalleryLink : `${baseGalleryLink}?page=${pageNum}`;
          console.log(`Navigating to gallery page ${pageNum}: ${galleryLink}`);
          
          const galleryResponse = await page.goto(galleryLink, { 
            waitUntil: 'domcontentloaded', 
            timeout: 90000 
          });
          
          if (!galleryResponse || galleryResponse.status() === 404) {
            console.log(`Page ${pageNum} not found, stopping pagination`);
            break;
          }

          // Wait for images with shorter timeout
          await page.waitForSelector('img', { timeout: 10000 }).catch(() => 
            console.log(`Image selector timeout on page ${pageNum}, proceeding...`)
          );

          // Fast scroll for gallery
          await page.evaluate(async () => {
            await new Promise(resolve => {
              let totalHeight = 0;
              const distance = 400; // Even faster scroll
              const maxScrolls = 10; // Fewer scrolls
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
              }, 30); // Very fast interval
            });
          });

          // Optimized image collection
          const pageImages = await page.evaluate(() => {
            const items = [];
            const seenUrls = new Set();
            
            // Get all images first
            const imgElements = document.querySelectorAll('img[src]');
            
            for (let i = 0; i < imgElements.length; i++) {
              const img = imgElements[i];
              let src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
              
              if (src && /\.(jpg|jpeg|png|gif|webp)/i.test(src)) {
                // Skip small images (likely icons)
                if (img.naturalWidth > 100 && img.naturalHeight > 100) {
                  const normalizedSrc = src.split('?')[0];
                  if (!seenUrls.has(normalizedSrc)) {
                    seenUrls.add(normalizedSrc);
                    items.push({ 
                      url: src, 
                      thumb: src 
                    });
                  }
                }
              }
            }
            
            // Then check links to images
            const linkElements = document.querySelectorAll('a[href*=".jpg"], a[href*=".jpeg"], a[href*=".png"], a[href*=".gif"], a[href*=".webp"]');
            
            for (let i = 0; i < linkElements.length; i++) {
              const link = linkElements[i];
              const href = link.href;
              if (href && /\.(jpg|jpeg|png|gif|webp)$/i.test(href)) {
                const normalizedHref = href.split('?')[0];
                if (!seenUrls.has(normalizedHref)) {
                  seenUrls.add(normalizedHref);
                  let thumb = href;
                  const img = link.querySelector('img');
                  if (img && img.src) {
                    thumb = img.src;
                  }
                  items.push({ 
                    url: href, 
                    thumb: thumb 
                  });
                }
              }
            }
            
            return items;
          });

          console.log(`Found ${pageImages.length} images on page ${pageNum}`);
          imageData.push(...pageImages);
          
          // Small delay between pages
          if (pageNum < maxPages) {
            await delay(500);
          }
        }

        await browser.close();
        browser = null;
      } catch (error) {
        console.error(`Attempt ${attempts} failed: ${error.message}`);
        if (browser) {
          await browser.close();
          browser = null;
        }
        if (attempts === maxAttempts) {
          throw error;
        }
      }
    }

    // Remove duplicate images
    const uniqueImageData = removeDuplicateImages(imageData);

    if (uniqueImageData.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No images found for "${model}" at index ${index}.`,
        suggestion: `Try "Mia Nanasawa" or "cosplay". Visit ${searchUrl} to confirm.`,
        debug: {
          search_url: searchUrl,
          gallery_url: galleryLinks[parseInt(index) - 1] || 'N/A',
          attempts_made: attempts,
          links_found: galleryLinks.length,
          original_images: imageData.length,
          unique_images: uniqueImageData.length
        }
      });
    }

    // Format and cache images
    const images = uniqueImageData.map((data, idx) => ({
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
      gallery_url: galleryLinks[parseInt(index) - 1] || 'N/A',
      cache_file: cacheFile,
      cached_at: new Date().toISOString(),
      duplicates_removed: imageData.length - uniqueImageData.length
    });
  } catch (error) {
    if (browser) await browser.close();
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

// Other endpoints remain the same
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(CACHE_DIR, model, `images_${index}.json`);
    const cachedData = await fs.readFile(cacheFile, 'utf8');
    const images = JSON.parse(cachedData);
    if (images.length === 0) {
      return res.status(404).send(
        `<html><body><h1>Error</h1><p>No images in cache. Run <a href="/api/album/${encodeURIComponent(model)}/${index}">/api/album/${encodeURIComponent(model)}/${index}</a> first.</p></body></html>`
      );
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

app.get('/', (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  res.send(`
    <html><head><title>Image Scraper API</title><style>body{margin:40px;font-family:Arial;}</style></head>
    <body>
      <h1>Image Scraper API Ready</h1>
      <p>Try: <a href="${baseUrl}/api/album/cosplay/1">${baseUrl}/api/album/cosplay/1</a></p>
      <p>Endpoints:</p>
      <ul>
        <li><a href="${baseUrl}/api/album/hot/1">${baseUrl}/api/album/hot/1</a></li>
        <li><a href="${baseUrl}/api/nsfw/hot/1">${baseUrl}/api/nsfw/hot/1</a></li>
        <li><a href="${baseUrl}/debug">${baseUrl}/debug</a></li>
      </ul>
    </body></html>
  `);
});

app.get('/debug', async (req, res) => {
  try {
    const executablePath = await verifyChromium();
    res.send(`Chromium found at ${executablePath}`);
  } catch (error) {
    res.status(500).send(`Chromium not found: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
});
