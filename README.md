# training-tools

Sync Pluralsight channels to YouTube playlists. Available as a CLI tool or as an MCP server for use with Claude and other AI assistants.

Chrome launches automatically with a persistent profile — log into Pluralsight and YouTube once, and sessions are remembered for future runs.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- Google Chrome installed

## Setup

```bash
git clone https://github.com/glennking/training-tools.git
cd training-tools
npm install
```

## CLI Usage

```bash
# Scrape a channel and create a YouTube playlist
node pluralsight-to-youtube.js <pluralsight-channel-url>

# Override the playlist name
node pluralsight-to-youtube.js <url> --name "My Playlist"

# Dry run — list videos without creating a playlist
node pluralsight-to-youtube.js <url> --dry-run

# Run headless (no visible browser window)
node pluralsight-to-youtube.js <url> --headless

# Connect to an existing Chrome instance via CDP instead of auto-launching
node pluralsight-to-youtube.js <url> --cdp http://127.0.0.1:9222
```

On first run, Chrome will open and you'll need to log into both Pluralsight and YouTube. After that, your sessions are persisted at `~/.training-tools/chrome-data`.

## MCP Server (for Claude)

The MCP server exposes two tools:

| Tool | Description |
|------|-------------|
| `scrape-pluralsight-channel` | Scrape a Pluralsight channel and return the list of YouTube videos |
| `sync-pluralsight-to-youtube` | Scrape a channel and create a YouTube playlist with the videos |

### Claude Code

Add to your project `.mcp.json` (already included in this repo):

```json
{
  "mcpServers": {
    "training-tools": {
      "command": "node",
      "args": ["/path/to/training-tools/mcp-server.js"]
    }
  }
}
```

Or add to `~/.claude.json` to make it available globally.

### Other MCP clients

Run the server over stdio:

```bash
node mcp-server.js
```

## How it works

1. Launches Chrome with a persistent user profile (or connects via CDP)
2. Navigates to the Pluralsight channel page and scrolls to load all content
3. Extracts all YouTube video links from the page
4. Creates a new YouTube playlist and adds each video to it
