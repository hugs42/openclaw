# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Model Context Protocol (MCP) server** that bridges Claude with the ChatGPT desktop app on macOS. It uses AppleScript and macOS Accessibility APIs to automate the ChatGPT UI, enabling Claude to send prompts and retrieve conversations from the ChatGPT app.

The entire server is a single TypeScript file ([index.ts](index.ts)) that exposes one MCP tool (`chatgpt`) with two operations:
- `ask` — sends a prompt to ChatGPT and waits for a response using text-stability detection
- `get_conversations` — retrieves conversation titles from the ChatGPT sidebar

## Build and Run Commands

```bash
bun install          # Install dependencies
bun run dev          # Run directly with bun (development)
npm run build        # Compile TypeScript → dist/ via tsc
npm start            # Run compiled output (node dist/index.js)
npx claude-chatgpt-mcp  # Run as published npm package
```

There are no tests or linting configured in this project.

## Architecture

**Transport**: stdio (reads/writes JSON-RPC over stdin/stdout via `StdioServerTransport`)

**Key dependencies**:
- `@modelcontextprotocol/sdk` — MCP server framework and type definitions
- `run-applescript` — executes AppleScript strings from Node.js
- `@jxa/run` — JavaScript for Automation (imported but not currently used in tool handlers)

**Flow**: MCP request → `CallToolRequestSchema` handler → `askChatGPT()` or `getConversations()` → AppleScript execution → ChatGPT desktop app UI automation → response text extraction → MCP response

**Response detection** in `askChatGPT()` uses a polling loop that:
1. Reads all `AXStaticText` elements from the ChatGPT window
2. Checks for text stability across 3 consecutive polls (1-second intervals)
3. Looks for typing indicator (`▍`) and completion markers (`Regenerate`, `Continue generating`)
4. Times out after 120 seconds

## Platform Constraints

- **macOS only** — relies on AppleScript and System Events
- Requires the ChatGPT desktop app to be installed and the user logged in
- Requires Accessibility permissions for the terminal running the server

## Deployment

- **Smithery**: configured via [smithery.yaml](smithery.yaml) for Smithery.ai registry
- **Docker**: [Dockerfile](Dockerfile) builds with Node 18 (note: AppleScript won't work in containers — Docker image is for registry/distribution purposes only)
- **npm**: published as `claude-chatgpt-mcp` with `dist/` as the package entry point
