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

import { connectChrome, scrapePlurasightChannel, createYoutubePlaylist } from './lib.js';

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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  let browser, page;
  try {
    ({ browser, page } = await connectChrome(opts.cdpUrl));
  } catch {
    console.error(`\nError: Cannot connect to Chrome at ${opts.cdpUrl}`);
    console.error('Make sure Chrome is running with --remote-debugging-port=9222');
    console.error('\nLaunch command:');
    console.error('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\');
    console.error('    --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug');
    process.exit(1);
  }

  try {
    // Step 1: Scrape Pluralsight channel
    console.log(`\nScraping Pluralsight channel: ${opts.channelUrl}`);
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
    await page.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
