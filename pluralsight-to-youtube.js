#!/usr/bin/env node

/**
 * Pluralsight Channel -> YouTube Playlist Sync Tool
 *
 * Prerequisites:
 *   1. Launch Chrome with remote debugging:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
 *   2. Log into both Pluralsight and YouTube in that browser
 *   3. Run: node pluralsight-to-youtube.js <channel-url> [options]
 *
 * Examples:
 *   node pluralsight-to-youtube.js https://app.pluralsight.com/channels/details/b45dfedb-...
 *   node pluralsight-to-youtube.js https://app.pluralsight.com/channels/details/b45dfedb-... --name "My Custom Name"
 *   node pluralsight-to-youtube.js https://app.pluralsight.com/channels/details/b45dfedb-... --dry-run
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node pluralsight-to-youtube.js <pluralsight-channel-url> [options]

Options:
  --name <name>    Override playlist name (default: channel title from Pluralsight)
  --dry-run        Scrape and list videos without creating a playlist
  --cdp <url>      Chrome DevTools Protocol URL (default: ${CDP_URL})
  -h, --help       Show this help message

Prerequisites:
  Launch Chrome with remote debugging enabled and log into Pluralsight + YouTube:

    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
      --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
`);
    process.exit(0);
  }

  const opts = { channelUrl: null, playlistName: null, dryRun: false, cdpUrl: CDP_URL };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      opts.playlistName = args[++i];
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--cdp' && args[i + 1]) {
      opts.cdpUrl = args[++i];
    } else if (!args[i].startsWith('-')) {
      opts.channelUrl = args[i];
    }
  }

  if (!opts.channelUrl) {
    console.error('Error: Pluralsight channel URL is required.');
    process.exit(1);
  }

  if (!opts.channelUrl.includes('pluralsight.com/channels/')) {
    console.error('Error: URL does not look like a Pluralsight channel URL.');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Step 1 – Scrape YouTube URLs from Pluralsight channel
// ---------------------------------------------------------------------------

async function scrapePlurasightChannel(page, channelUrl) {
  console.log(`\nScraping Pluralsight channel: ${channelUrl}`);

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

  // Get channel title
  const channelTitle = await page.title();
  // Strip " | Pluralsight" suffix if present
  const cleanTitle = channelTitle.replace(/\s*\|\s*Pluralsight\s*$/, '').trim();

  // Extract YouTube links with titles
  const videos = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const seen = new Set();
    const results = [];

    for (const a of links) {
      const href = a.href;
      if (!href.includes('youtube.com/watch') && !href.includes('youtu.be/')) continue;

      // Normalize URL — strip playlist params to get clean video URL
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

// ---------------------------------------------------------------------------
// Step 2 – Create YouTube playlist and add videos
// ---------------------------------------------------------------------------

async function createYoutubePlaylist(page, playlistName, videos) {
  console.log(`\nCreating YouTube playlist: "${playlistName}"`);
  console.log(`Adding ${videos.length} videos...\n`);

  let playlistCreated = false;

  for (let i = 0; i < videos.length; i++) {
    const { url, title } = videos[i];
    const label = `[${i + 1}/${videos.length}]`;
    console.log(`${label} ${title}`);
    console.log(`     ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);

      // Click "Save to playlist" (button is in overflow, use JS click)
      const hasSaveBtn = await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Save to playlist"]');
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!hasSaveBtn) {
        console.log(`     -> SKIP: Save button not found (may not be a valid video)`);
        continue;
      }

      await page.waitForTimeout(2000);

      if (!playlistCreated) {
        // First video — create the playlist
        await page.evaluate(() => {
          document.querySelector('button[aria-label="Create new playlist"]').click();
        });
        await page.waitForTimeout(2000);

        // Fill playlist name via JS (placeholder overlay blocks normal clicks)
        await page.evaluate((name) => {
          const textarea = document.querySelector('ytd-popup-container textarea[placeholder="Choose a title"]');
          if (!textarea) throw new Error('Playlist name textarea not found');
          textarea.focus();
          textarea.value = name;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }, playlistName);
        await page.waitForTimeout(1000);

        // Click Create
        await page.evaluate(() => {
          document.querySelector('ytd-popup-container button[aria-label="Create"]').click();
        });
        await page.waitForTimeout(3000);

        playlistCreated = true;
        console.log(`     -> Created playlist & added`);
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

        console.log(`     -> ${result}`);
        await page.waitForTimeout(1000);
      }

      // Close dialog
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

    } catch (err) {
      console.log(`     -> ERROR: ${err.message.split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // Verify Chrome is reachable
  let browser;
  try {
    browser = await chromium.connectOverCDP(opts.cdpUrl);
  } catch {
    console.error(`\nError: Cannot connect to Chrome at ${opts.cdpUrl}`);
    console.error('Make sure Chrome is running with --remote-debugging-port=9222');
    console.error('\nLaunch command:');
    console.error('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\');
    console.error('    --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug');
    process.exit(1);
  }

  const defaultContext = browser.contexts()[0];
  const page = await defaultContext.newPage();

  try {
    // Step 1: Scrape Pluralsight channel
    const { channelTitle, videos } = await scrapePlurasightChannel(page, opts.channelUrl);

    if (videos.length === 0) {
      console.error('\nNo YouTube videos found on this channel.');
      console.error('Make sure you are logged into Pluralsight in the debug Chrome window.');
      process.exit(1);
    }

    const playlistName = opts.playlistName || channelTitle;

    console.log(`\nChannel: ${channelTitle}`);
    console.log(`Playlist name: ${playlistName}`);
    console.log(`Videos found: ${videos.length}`);
    console.log('---');
    videos.forEach((v, i) => console.log(`  ${i + 1}. ${v.title} — ${v.url}`));

    if (opts.dryRun) {
      console.log('\n--dry-run specified. Stopping here.');
      return;
    }

    // Step 2: Create playlist and add videos
    await createYoutubePlaylist(page, playlistName, videos);

    console.log(`\nDone! Playlist "${playlistName}" should now have ${videos.length} videos.`);

  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
