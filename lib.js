import { chromium } from 'playwright';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_DATA_DIR = join(homedir(), '.training-tools', 'chrome-data');

/**
 * Launch or connect to a Chrome browser.
 *
 * By default, launches Chrome with a persistent profile at ~/.training-tools/chrome-data
 * so that Pluralsight/YouTube logins survive between runs.
 *
 * Options:
 *   cdpUrl   - If set, connect to an existing Chrome instance via CDP instead of launching.
 *   dataDir  - Custom persistent profile directory (default: ~/.training-tools/chrome-data).
 *   headless - Run headless (default: false — you need to see the browser to log in).
 *
 * Returns { browser, context, page, cleanup() }.
 * Call cleanup() when done instead of manually closing browser/page.
 */
export async function launchBrowser(opts = {}) {
  const { cdpUrl, dataDir = DEFAULT_DATA_DIR, headless = false } = opts;

  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    return {
      browser, context, page,
      async cleanup() { await page.close(); await browser.close(); },
    };
  }

  const context = await chromium.launchPersistentContext(dataDir, {
    channel: 'chrome',
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: null,
  });
  const page = context.pages()[0] || await context.newPage();
  return {
    browser: null, context, page,
    async cleanup() { await context.close(); },
  };
}

/**
 * Scrape YouTube video URLs from a Pluralsight channel page.
 * Returns { channelTitle, videos: [{ url, title }] }
 */
export async function scrapePlurasightChannel(page, channelUrl) {
  await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Scroll to load all content
  let previousHeight = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break;
    previousHeight = currentHeight;
  }

  const channelTitle = await page.title();
  const cleanTitle = channelTitle.replace(/\s*\|\s*Pluralsight\s*$/, '').trim();

  const videos = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const seen = new Set();
    const results = [];

    for (const a of links) {
      const href = a.href;
      if (!href.includes('youtube.com/watch') && !href.includes('youtu.be/')) continue;

      let url;
      try {
        const parsed = new URL(href);
        if (parsed.hostname.includes('youtu.be')) {
          url = `https://www.youtube.com/watch?v=${parsed.pathname.slice(1)}`;
        } else {
          const videoId = parsed.searchParams.get('v');
          if (!videoId) continue;
          url = `https://www.youtube.com/watch?v=${videoId}`;
        }
      } catch {
        continue;
      }

      if (seen.has(url)) continue;
      seen.add(url);

      const title = a.textContent.trim() || 'Untitled';
      results.push({ url, title });
    }

    return results;
  });

  return { channelTitle: cleanTitle, videos };
}

/**
 * Create a YouTube playlist and add videos to it.
 * Returns a log of results per video.
 */
export async function createYoutubePlaylist(page, playlistName, videos) {
  const results = [];
  let playlistCreated = false;

  for (let i = 0; i < videos.length; i++) {
    const { url, title } = videos[i];
    const entry = { index: i + 1, title, url, status: 'pending' };

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);

      const hasSaveBtn = await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Save to playlist"]');
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!hasSaveBtn) {
        entry.status = 'skipped';
        entry.reason = 'Save button not found';
        results.push(entry);
        continue;
      }

      await page.waitForTimeout(2000);

      if (!playlistCreated) {
        await page.evaluate(() => {
          document.querySelector('button[aria-label="Create new playlist"]').click();
        });
        await page.waitForTimeout(2000);

        await page.evaluate((name) => {
          const textarea = document.querySelector('ytd-popup-container textarea[placeholder="Choose a title"]');
          if (!textarea) throw new Error('Playlist name textarea not found');
          textarea.focus();
          textarea.value = name;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }, playlistName);
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
          document.querySelector('ytd-popup-container button[aria-label="Create"]').click();
        });
        await page.waitForTimeout(3000);

        playlistCreated = true;
        entry.status = 'created-and-added';
      } else {
        const result = await page.evaluate((name) => {
          const buttons = document.querySelectorAll('ytd-popup-container button');
          for (const btn of buttons) {
            if (btn.textContent.includes(name)) {
              const isChecked = btn.getAttribute('aria-pressed') === 'true' ||
                                btn.querySelector('svg path[d*="check"]') !== null;
              if (isChecked) return 'already-added';
              btn.click();
              return 'added';
            }
          }
          return 'not-found';
        }, playlistName);

        entry.status = result;
        await page.waitForTimeout(1000);
      }

      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

    } catch (err) {
      entry.status = 'error';
      entry.reason = err.message.split('\n')[0];
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }

    results.push(entry);
  }

  return results;
}
