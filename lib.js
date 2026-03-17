import { chromium } from 'playwright';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const CONFIG_DIR = join(homedir(), '.training-tools');
const DEFAULT_DATA_DIR = join(CONFIG_DIR, 'chrome-data');
const AUTH_STATE_PATH = join(CONFIG_DIR, 'auth.json');

/**
 * Launch or connect to a Chrome browser.
 *
 * By default, launches Chrome with a persistent profile at ~/.training-tools/chrome-data.
 * Restores saved auth state (cookies/localStorage) from ~/.training-tools/auth.json
 * if available, so logins persist even if the browser was killed ungracefully.
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

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    // Restore saved auth state into CDP context if available
    if (existsSync(AUTH_STATE_PATH)) {
      const { cookies } = JSON.parse((await import('fs')).readFileSync(AUTH_STATE_PATH, 'utf8'));
      if (cookies?.length) await context.addCookies(cookies);
    }
    const page = await context.newPage();
    return {
      browser, context, page,
      async cleanup() {
        await saveAuthState(context);
        await page.close();
        await browser.close();
      },
    };
  }

  // Build launch options
  const launchOpts = {
    channel: 'chrome',
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: null,
  };

  const context = await chromium.launchPersistentContext(dataDir, launchOpts);

  // Restore saved auth state (cookies) into the persistent context.
  // This covers cases where the browser was killed before cookies flushed to the profile.
  if (existsSync(AUTH_STATE_PATH)) {
    try {
      const { cookies } = JSON.parse((await import('fs')).readFileSync(AUTH_STATE_PATH, 'utf8'));
      if (cookies?.length) await context.addCookies(cookies);
    } catch { /* ignore corrupt file */ }
  }

  const page = context.pages()[0] || await context.newPage();
  return {
    browser: null, context, page,
    async cleanup() {
      await saveAuthState(context);
      await context.close();
    },
  };
}

/**
 * Save auth state (cookies + localStorage origins) to ~/.training-tools/auth.json.
 */
async function saveAuthState(context) {
  try {
    await context.storageState({ path: AUTH_STATE_PATH });
  } catch { /* context may already be closed */ }
}

/**
 * Ensure the page is logged into Pluralsight.
 * If a login redirect is detected, waits for the user to complete login,
 * then saves auth state for future runs.
 * Returns true if login was required, false if already logged in.
 */
export async function ensureLoggedIn(page, targetUrl) {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  if (!page.url().includes('/id')) return false;

  console.error('Pluralsight login required. Please log in using the Chrome window...');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (!page.url().includes('/id')) break;
  }
  if (page.url().includes('/id')) {
    throw new Error('Pluralsight login timed out after 3 minutes.');
  }

  // Save auth state immediately after login so it survives crashes
  await saveAuthState(page.context());

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  return true;
}

/**
 * Ensure the browser is logged into YouTube.
 * If not logged in, waits for the user to sign in, then saves auth state.
 * Returns true if login was required, false if already logged in.
 */
export async function ensureYouTubeLoggedIn(page) {
  await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const loggedIn = await page.evaluate(() => {
    return !!document.querySelector('button#avatar-btn, img.yt-spec-avatar-shape__avatar');
  });

  if (loggedIn) return false;

  console.error('YouTube login required. Please sign into YouTube in the Chrome window...');
  await page.waitForSelector('button#avatar-btn, img.yt-spec-avatar-shape__avatar', { timeout: 180000 });
  await page.waitForTimeout(2000);

  // Save auth state immediately after login
  await saveAuthState(page.context());

  return true;
}

/**
 * Scrape YouTube video URLs from a Pluralsight channel page.
 * Assumes the page is already logged in (call ensureLoggedIn first).
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

      // Try to find a title from the link text or nearby elements
      let title = a.textContent.trim();
      if (!title) {
        const container = a.closest('[class*="content"]') || a.closest('[class*="card"]') || a.closest('[class*="item"]') || a.closest('li');
        if (container) {
          const heading = container.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"]');
          if (heading) title = heading.textContent.trim();
        }
      }
      results.push({ url, title: title || 'Untitled' });
    }

    return results;
  });

  return { channelTitle: cleanTitle, videos };
}

/**
 * Create a YouTube playlist and add videos to it.
 * Uses Playwright's locator API which re-queries the DOM on each action,
 * avoiding stale element issues with YouTube's SPA.
 * Returns a log of results per video.
 */
export async function createYoutubePlaylist(page, playlistName, videos) {
  const results = [];
  let playlistCreated = false;

  for (let i = 0; i < videos.length; i++) {
    const { url, title } = videos[i];
    const entry = { index: i + 1, title, url, status: 'pending' };

    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
      // YouTube is an SPA — wait for the video page to actually render
      await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Wait for the Save button to exist in the DOM, then JS-click it.
      // YouTube keeps it hidden until scroll, so we use JS click + scrollIntoView.
      const saveBtn = page.locator('button[aria-label="Save to playlist"]');
      try {
        await saveBtn.waitFor({ state: 'attached', timeout: 15000 });
      } catch {
        entry.status = 'skipped';
        entry.reason = 'Save button not found';
        results.push(entry);
        continue;
      }

      await saveBtn.evaluate(el => { el.scrollIntoView(); el.click(); });
      await page.waitForTimeout(2000);

      if (!playlistCreated) {
        // First video — create the playlist
        const newPlaylistBtn = page.locator('button[aria-label="Create new playlist"]');
        await newPlaylistBtn.waitFor({ state: 'attached', timeout: 5000 });
        await newPlaylistBtn.evaluate(el => el.click());
        await page.waitForTimeout(2000);

        // Fill playlist name
        const textarea = page.locator('ytd-popup-container textarea[placeholder="Choose a title"]');
        await textarea.waitFor({ state: 'attached', timeout: 5000 });
        await textarea.evaluate((el, name) => {
          el.focus();
          el.value = name;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, playlistName);
        await page.waitForTimeout(1000);

        // Click Create
        const createBtn = page.locator('ytd-popup-container button[aria-label="Create"]');
        await createBtn.waitFor({ state: 'attached', timeout: 5000 });
        await createBtn.evaluate(el => el.click());
        await page.waitForTimeout(3000);

        playlistCreated = true;
        entry.status = 'created-and-added';
      } else {
        // Subsequent videos — check the playlist checkbox
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

      // Close dialog
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
