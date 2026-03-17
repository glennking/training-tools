#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { launchBrowser, scrapePlurasightChannel, createYoutubePlaylist } from './lib.js';

const server = new McpServer({
  name: 'training-tools',
  version: '1.0.0',
});

server.tool(
  'scrape-pluralsight-channel',
  'Scrape a Pluralsight channel page to extract YouTube video URLs and titles. Chrome launches automatically with a persistent profile. On first use, the user must log into Pluralsight in the browser window that opens.',
  {
    channelUrl: z.string().describe('Pluralsight channel URL (e.g. https://app.pluralsight.com/channels/details/...)'),
    cdpUrl: z.string().optional().describe('Connect to existing Chrome via CDP instead of auto-launching'),
    headless: z.boolean().optional().default(false).describe('Run Chrome headless (default: false)'),
  },
  async ({ channelUrl, cdpUrl, headless }) => {
    if (!channelUrl.includes('pluralsight.com/channels/')) {
      return { content: [{ type: 'text', text: 'Error: URL does not look like a Pluralsight channel URL.' }], isError: true };
    }

    let page, cleanup;
    try {
      ({ page, cleanup } = await launchBrowser({ cdpUrl, headless }));
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Failed to launch Chrome: ${err.message}` }],
        isError: true,
      };
    }

    try {
      const { channelTitle, videos } = await scrapePlurasightChannel(page, channelUrl);

      if (videos.length === 0) {
        return {
          content: [{ type: 'text', text: 'No YouTube videos found on this channel. Make sure you are logged into Pluralsight in the Chrome window.' }],
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
      await cleanup();
    }
  }
);

server.tool(
  'sync-pluralsight-to-youtube',
  'Scrape a Pluralsight channel for YouTube videos and create a YouTube playlist with them. Chrome launches automatically with a persistent profile. On first use, the user must log into both Pluralsight and YouTube in the browser window that opens.',
  {
    channelUrl: z.string().describe('Pluralsight channel URL'),
    playlistName: z.string().optional().describe('Override playlist name (defaults to the channel title from Pluralsight)'),
    cdpUrl: z.string().optional().describe('Connect to existing Chrome via CDP instead of auto-launching'),
    headless: z.boolean().optional().default(false).describe('Run Chrome headless (default: false)'),
  },
  async ({ channelUrl, playlistName, cdpUrl, headless }) => {
    if (!channelUrl.includes('pluralsight.com/channels/')) {
      return { content: [{ type: 'text', text: 'Error: URL does not look like a Pluralsight channel URL.' }], isError: true };
    }

    let page, cleanup;
    try {
      ({ page, cleanup } = await launchBrowser({ cdpUrl, headless }));
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Failed to launch Chrome: ${err.message}` }],
        isError: true,
      };
    }

    try {
      const { channelTitle, videos } = await scrapePlurasightChannel(page, channelUrl);

      if (videos.length === 0) {
        return {
          content: [{ type: 'text', text: 'No YouTube videos found on this channel. Make sure you are logged into Pluralsight in the Chrome window.' }],
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
      await cleanup();
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
