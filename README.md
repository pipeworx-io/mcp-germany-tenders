# mcp-germany-tenders

Germany public procurement MCP — official German government tenders (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `germany_search_tenders` | Search official GERMAN government public-procurement tenders (Öffentliche Vergabe / Ausschreibungen) from the federal Bekanntmachungsservice open-data feed (oeffentlichevergabe.de), Open Contracting Data Standard (OCDS, CC0). Returns each notice shaped: ocid, title, buyer/Vergabestelle, contract value in EUR, procurement category, CPV code, procurement method, submission deadline, and publish date. Filter by publish-date range and/or a keyword (matched against title, description, buyer, and CPV description — German text). Defaults to the most recent days if no dates given. Can answer wide date ranges (months) as well as very recent days. Data covers Germany only. |
| `germany_buyer_spend_history` | Procurement spend history for a GERMAN government buyer (Vergabestelle) — e.g. a city, a ministry, a university hospital — across German OCDS tender notices (oeffentlichevergabe.de, CC0). Matches the buyer name (case-insensitive substring, e.g. "Universitätsklinikum Halle", "Stadt Angermünde"). Returns process count, how many of those disclosed a EUR value (German notices below the EU publication threshold frequently omit contract value — this is reported, not hidden), total disclosed spend in EUR, top procurement categories, and a sample of recent processes. Spans up to 12+ months (see data_as_of in the response for the current coverage). |
| `germany_supplier_win_history` | Contract-win history for a GERMAN supplier/contractor (e.g. "Uniola AG", "System Strobel GmbH") across German OCDS tender notices (oeffentlichevergabe.de, CC0) — which buyers they won work from, award dates, and disclosed EUR values where published. COVERAGE IS GENUINELY PARTIAL: the winning supplier and award value are disclosed on only a small minority of German notices (below-threshold contracts routinely omit both) — the response reports won_count vs. value_disclosed_count so that gap is visible rather than read as "no data". See data_as_of in the response for the current coverage. |

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/germany-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/germany_search_tenders \
  -H 'Content-Type: application/json' \
  -d '{"date_from":"2024-11-01","date_to":"2024-11-15","query":"Bauarbeiten","limit":25}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/germany_search_tenders`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-germany-tenders` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/germany-tenders/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "germany-tenders": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-germany-tenders"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Germany Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
