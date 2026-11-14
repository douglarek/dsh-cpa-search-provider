# @douglarek/dsh-cpa-search-provider

A CPA Responses web search and fetch provider for DeepSeek Harness.

- `cpa-search` calls an OpenAI-compatible `/responses` endpoint with `web_search_preview` and returns the model answer plus grounded sources.
- `cpa-fetch` fetches static pages directly over HTTP(S); when the response has no useful body, or the page is JavaScript/login-walled, it falls back to model-mediated reading.
- No DuckDuckGo, Python, MCP, uvx, or npm runtime dependencies. Node.js built-ins only.

The bundle registers two providers; it does **not** bundle an endpoint, a credential, or a provider selection.

## Install

```text
github:douglarek/dsh-cpa-search-provider
```

After installation, configure `endpoint` and `apiKey` in your private profile patch (see below), then select `cpa-search` and `cpa-fetch` in **Plugins → Built-in plugin settings → Web search and fetch**, or pin them with a `web` override.

## Plugin index

This plugin is listed in [dsh-plugin-index](https://github.com/douglarek/dsh-plugin-index).

Index URL:

```text
https://raw.githubusercontent.com/douglarek/dsh-plugin-index/main/index.json
```

Every `package.json` version bump must add the matching version and release commit to the index. The `Plugin index` GitHub Actions check fails a version-changing push until the index lists that exact version at that commit. See [RELEASING.md](RELEASING.md).

## Configuration

Add this to your private `cordis.patch.yml` (replace the placeholders locally; do not commit the real values to a public repository):

```yaml
- id: web-search-cpa
  name: "@douglarek/dsh-cpa-search-provider"
  config:
    endpoint: https://your-endpoint.example/v1
    model: your-responses-model
    reasoningEffort: low
    apiKey: $YOUR_API_KEY
    searchProviderId: cpa-search
    fetchProviderId: cpa-fetch
    searchTimeoutMs: 60000
    fetchTimeoutMs: 30000
    readFallback: true
```

To pin the built-in web tools to this provider:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: cpa-search
    fetchProvider: cpa-fetch
```

| Field | Default | Description |
| --- | --- | --- |
| `endpoint` | *(required)* | OpenAI-compatible Responses API root |
| `model` | `gpt-6-luna` | Model used for search and model-mediated reading |
| `reasoningEffort` | `low` | Responses API reasoning effort; empty omits the field |
| `apiKey` | *(required)* | Literal key, `$ENV`, or `!command` resolved lazily |
| `searchProviderId` | `cpa-search` | Search provider id registered with `ctx.web` |
| `fetchProviderId` | `cpa-fetch` | Fetch provider id registered with `ctx.web` |
| `searchTimeoutMs` | `60000` | Search timeout |
| `fetchTimeoutMs` | `30000` | Fetch/model-read timeout |
| `maxChars` | `100000` | Character cap for returned content |
| `maxBytes` | `2000000` | Byte cap for fetched responses |
| `readFallback` | `true` | Fall back to model reading when direct fetch fails or returns no useful body |

The provider is unavailable until both `endpoint` and `apiKey` are configured. The `!` command in `apiKey` is executed lazily on the first request; `available()` never starts a subprocess.

## How it works

`cpa-search` sends the query to `/responses` with `tools: [{ type: "web_search_preview" }]`. It extracts the final `message` text and any `web_search_call.action.sources` or citation annotations, then returns them through the DSH search-provider contract.

`cpa-fetch` first performs a direct `fetch()` with a browser-like User-Agent, follows redirects, decodes the response, and returns raw HTML or text. If the body is empty or effectively unreadable, it calls the model with the page URL and a “read this page” prompt, then returns the extracted text as a successful fetch result.

## Limitations

1. **Search is model-mediated.** Every `cpa-search` call is one model request. The answer may be summarized rather than a raw result list; sources depend on what the provider returns.
2. **Fetch falls back to the model.** Static pages use a normal HTTP request; JS/login-walled pages may use the model-read fallback, which is another model request.
3. **Requires `/responses` + `web_search_preview` support.** Verify both when changing the endpoint or model.
4. **Requires an API key.** Provide it through the private profile configuration; do not commit it.
5. **Source coverage varies.** Some models return `web_search_call` entries without populated `action.sources`; the built-in tool can still show the answer, but there may be no citation URLs.

## License

MIT
