# mcp-germany-tenders

Germany public procurement MCP — official German government tenders (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `germany_search_tenders` | Search official GERMAN government public-procurement tenders (Öffentliche Vergabe / Ausschreibungen) from the federal Bekanntmachungsservice open-data feed (oeffentlichevergabe.de), Open Contracting Data Standard (OCDS). Returns each notice shaped: ocid, title, buyer/Vergabestelle, contract value in EUR, procurement category, CPV code, procurement method, submission deadline, and publish date. Filter by publish-date range and/or a keyword (matched against title, description, buyer, and CPV description — German text). Defaults to the most recent days if no dates given. Data covers Germany only. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "germany-tenders": {
      "url": "https://gateway.pipeworx.io/germany-tenders/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Germany Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
