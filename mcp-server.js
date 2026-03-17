#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectChrome, scrapePlurasightChannel, createYoutubePlaylist } from './lib.js';

const server = new McpServer({
  name: 'training-tools',
  version: '1.0.0',
});

server.tool(
  'scrape-pluralsight-channel',
  'Scrape a Pluralsight channel page to extract YouTube video URLs and titles. Requires Chrome running with --remote-debugging-port=9222 and logged into Pluralsight.',
  {
    channelUrl: z.string().describe('Pluralsight channel URL (e.g. https://app.pluralsight.com/channels/details/...)'),
    cdpUrl: z.string().optional().default('http://127.0.0.1:9222').describe('Chrome DevTools Protocol URL'),
  },
  async ({ channelUrl, cdpUrl }) => {
    if (!channelUrl.includes('pluralsight.com/channels/')) {
      return { content: [{ type: 'text', text: 'Error: URL does not look like a Pluralsight channel URL.' }], isError: true };
    }

    let browser, page;
    try {
      ({ browser, page } = await connectChrome(cdpUrl));
    } catch {
      return {
        content: [{ type: 'text', text: `Error: Cannot connect to Chrome at ${cdpUrl}. Make sure Chrome is running with --remote-debugging-port=9222` }],
        isError: true,
      };
    }

    try {
      const { channelTitle, videos } = await scrapePlurasightChannel(page, channelUrl);

      if (videos.length === 0) {
        return {
          content: [{ type: 'text', text: 'No YouTube videos found on this channel. Make sure you are logged into Pluralsight in the debug Chrome window.' }],
          isError: true,
        };
      }

      const listing = videos.map((v, i) => `${i + 1}. ${v.title}\n   ${v.url}`).join('\n');
      return {
        content: [{
          type: 'text',
          text: `Channel: ${channelTitle}\nVideos found: ${videos.length}\n\n${listing}`,
        }],
      };
    } finally {
      await page.close();
      await browser.close();
    }
  }
);

server.tool(
  'sync-pluralsight-to-youtube',
  'Scrape a Pluralsight channel for YouTube videos and create a YouTube playlist with them. Requires Chrome running with --remote-debugging-port=9222 and logged into both Pluralsight and YouTube.',
  {
    channelUrl: z.string().describe('Pluralsight channel URL'),
    playlistName: z.string().optional().describe('Override playlist name (defaults to the channel title from Pluralsight)'),
    cdpUrl: z.string().optional().default('http://127.0.0.1:9222').describe('Chrome DevTools Protocol URL'),
  },
  async ({ channelUrl, playlistName, cdpUrl }) => {
    if (!channelUrl.includes('pluralsight.com/channels/')) {
      return { content: [{ type: 'text', text: 'Error: URL does not look like a Pluralsight channel URL.' }], isError: true };
    }

    let browser, page;
    try {
      ({ browser, page } = await connectChrome(cdpUrl));
    } catch {
      return {
        content: [{ type: 'text', text: `Error: Cannot connect to Chrome at ${cdpUrl}. Make sure Chrome is running with --remote-debugging-port=9222` }],
        isError: true,
      };
    }

    try {
      const { channelTitle, videos } = await scrapePlurasightChannel(page, channelUrl);

      if (videos.length === 0) {
        return {
          content: [{ type: 'text', text: 'No YouTube videos found on this channel. Make sure you are logged into Pluralsight in the debug Chrome window.' }],
          isError: true,
        };
      }

      const name = playlistName || channelTitle;
      const results = await createYoutubePlaylist(page, name, videos);

      const summary = results.map(r => `${r.index}. [${r.status}] ${r.title}`).join('\n');
      return {
        content: [{
          type: 'text',
          text: `Playlist: "${name}"\nTotal videos: ${videos.length}\n\nResults:\n${summary}`,
        }],
      };
    } finally {
      await page.close();
      await browser.close();
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
