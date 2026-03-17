#!/usr/bin/env node

/**
 * Pluralsight Channel -> YouTube Playlist Sync Tool
 *
 * Chrome launches automatically with a persistent profile (~/.training-tools/chrome-data)
 * so that your Pluralsight and YouTube logins are remembered between runs.
 *
 * First run: log into both Pluralsight and YouTube when the browser opens.
 * Subsequent runs: sessions are preserved, no login needed.
 *
 * Examples:
 *   node pluralsight-to-youtube.js https://app.pluralsight.com/channels/details/b45dfedb-...
 *   node pluralsight-to-youtube.js https://app.pluralsight.com/channels/details/b45dfedb-... --name "My Custom Name"
 *   node pluralsight-to-youtube.js https://app.pluralsight.com/channels/details/b45dfedb-... --dry-run
 */

import { launchBrowser, ensureLoggedIn, scrapePlurasightChannel, createYoutubePlaylist } from './lib.js';

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
  --headless       Run Chrome in headless mode (default: visible)
  --cdp <url>      Connect to existing Chrome via CDP instead of auto-launching
  -h, --help       Show this help message

Chrome launches automatically with a persistent profile at ~/.training-tools/chrome-data.
On first run, log into Pluralsight and YouTube. Sessions are preserved for future runs.
`);
    process.exit(0);
  }

  const opts = { channelUrl: null, playlistName: null, dryRun: false, cdpUrl: null, headless: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      opts.playlistName = args[++i];
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--headless') {
      opts.headless = true;
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  let cleanup;
  let page;
  try {
    ({ page, cleanup } = await launchBrowser({
      cdpUrl: opts.cdpUrl,
      headless: opts.headless,
    }));
  } catch (err) {
    console.error(`\nError: Failed to launch Chrome: ${err.message}`);
    if (opts.cdpUrl) {
      console.error(`Make sure Chrome is running and accessible at ${opts.cdpUrl}`);
    } else {
      console.error('Make sure Google Chrome is installed on this system.');
    }
    process.exit(1);
  }

  try {
    // Step 1: Ensure logged in, then scrape
    console.log(`\nNavigating to Pluralsight channel: ${opts.channelUrl}`);
    const loginRequired = await ensureLoggedIn(page, opts.channelUrl);
    if (loginRequired) {
      console.log('Login completed successfully.');
    }

    console.log('Scraping channel...');
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
    console.log(`\nCreating YouTube playlist: "${playlistName}"`);
    console.log(`Adding ${videos.length} videos...\n`);

    const results = await createYoutubePlaylist(page, playlistName, videos);
    results.forEach(r => {
      console.log(`[${r.index}/${videos.length}] ${r.title}`);
      console.log(`     ${r.url}`);
      console.log(`     -> ${r.status}${r.reason ? ': ' + r.reason : ''}`);
    });

    console.log(`\nDone! Playlist "${playlistName}" should now have ${videos.length} videos.`);

  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
