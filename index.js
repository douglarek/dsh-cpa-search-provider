/**
 * @douglarek/dsh-cpa-search-provider
 *
 * A dependency-free DSH web provider that replaces vendor search backends
 * with the CPA OpenAI-compatible Responses API:
 *
 *   - cpa-search: POST /responses with `web_search_preview`, returning the
 *     model's answer plus its grounded sources.
 *   - cpa-fetch: direct HTTP(S) fetch for static pages, with a model-grounded
 *     `web_read` fallback for JavaScript/login-walled pages.
 *
 * It is a direct port of the native-search-mcp search/fetch/read flow, but
 * runs as a normal `ctx.web` search/fetch provider. Runtime dependencies:
 * Node.js built-ins only.
 */

import { execFileSync } from "node:child_process";

const DEFAULTS = {
  endpoint: "",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  apiKey: "",
  searchProviderId: "cpa-search",
  fetchProviderId: "cpa-fetch",
  searchTimeoutMs: 60_000,
  fetchTimeoutMs: 30_000,
  maxChars: 100_000,
  maxBytes: 2_000_000,
  readFallback: true,
};

class CpaWebError extends Error {
  constructor(message, code = "WEB_PROVIDER_ERROR", options) {
    super(message, options);
    this.name = "WebError";
    this.code = code;
  }
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULTS, ...(input ?? {}) };
  return {
    endpoint: String(config.endpoint ?? "").trim().replace(/\/+$/, ""),
    model: String(config.model ?? "").trim(),
    reasoningEffort: String(
      config.reasoningEffort ?? DEFAULTS.reasoningEffort,
    ).trim(),
    apiKey: String(config.apiKey ?? "").trim(),
    searchProviderId:
      String(config.searchProviderId ?? DEFAULTS.searchProviderId).trim() ||
      DEFAULTS.searchProviderId,
    fetchProviderId:
      String(config.fetchProviderId ?? DEFAULTS.fetchProviderId).trim() ||
      DEFAULTS.fetchProviderId,
    searchTimeoutMs: clampInt(
      config.searchTimeoutMs,
      DEFAULTS.searchTimeoutMs,
      1_000,
      180_000,
    ),
    fetchTimeoutMs: clampInt(
      config.fetchTimeoutMs,
      DEFAULTS.fetchTimeoutMs,
      1_000,
      180_000,
    ),
    maxChars: clampInt(config.maxChars, DEFAULTS.maxChars, 1_000, 500_000),
    maxBytes: clampInt(config.maxBytes, DEFAULTS.maxBytes, 1_024, 10_000_000),
    readFallback: config.readFallback !== false,
  };
}

class ApiKeyResolver {
  constructor(raw) {
    this.raw = raw;
    this.cached = undefined;
  }

  /** Cheap local check: never spawns a process. */
  configured() {
    if (!this.raw) return false;
    if (this.raw.startsWith("$")) {
      const name = this.raw.slice(1).replace(/^\{|\}$/g, "");
      return Boolean(process.env[name]?.trim());
    }
    return true;
  }

  resolve() {
    if (this.cached !== undefined) return this.cached;
    let key = "";
    if (this.raw.startsWith("!")) {
      const command = this.raw.slice(1).trim();
      try {
        key = execFileSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch (error) {
        throw new CpaWebError(
          `Could not resolve the CPA API key with "${command}": ${error.message}`,
        );
      }
    } else if (this.raw.startsWith("$")) {
      const name = this.raw.slice(1).replace(/^\{|\}$/g, "");
      key = process.env[name]?.trim() ?? "";
    } else {
      key = this.raw.trim();
    }
    if (!key) {
      throw new CpaWebError(
        "The CPA API key is empty. Set config.apiKey.",
      );
    }
    this.cached = key;
    return key;
  }
}

function withTimeout(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function httpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new CpaWebError(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CpaWebError(`Only http(s) URLs are supported: ${raw}`);
  }
  return parsed.toString();
}

function responseSources(item, add) {
  const action = item?.action ?? {};
  for (const source of Array.isArray(action.sources) ? action.sources : []) {
    add(source?.url, source?.title);
  }
  add(action.url);
}

function extractOutput(data, maxResults) {
  const outputs = Array.isArray(data?.output) ? data.output : [];
  const textParts = [];
  const sources = [];
  const seen = new Set();

  const add = (url, title) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    const source = { url };
    if (typeof title === "string" && title.trim()) source.title = title.trim();
    sources.push(source);
  };

  for (const item of outputs) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const content of Array.isArray(item.content) ? item.content : []) {
        if (typeof content?.text === "string") textParts.push(content.text);
        for (const annotation of Array.isArray(content?.annotations)
          ? content.annotations
          : []) {
          add(annotation?.url, annotation?.title);
        }
      }
    } else if (item.type === "web_search_call") {
      responseSources(item, add);
    }
  }

  let limited = sources;
  let truncated = false;
  if (
    Number.isFinite(maxResults) &&
    maxResults > 0 &&
    sources.length > maxResults
  ) {
    limited = sources.slice(0, maxResults);
    truncated = true;
  }

  return {
    text: textParts.join("\n").trim(),
    sources: limited,
    truncated,
  };
}

async function postResponses(config, resolver, prompt, signal, timeoutMs) {
  if (!config.endpoint) {
    throw new CpaWebError("The CPA endpoint is empty.");
  }
  if (!config.model) {
    throw new CpaWebError("The CPA model is empty.");
  }
  const apiKey = resolver.resolve();
  const timeout = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(`${config.endpoint}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: prompt,
        tools: [{ type: "web_search_preview" }],
        ...(config.reasoningEffort
          ? { reasoning: { effort: config.reasoningEffort } }
          : {}),
      }),
      signal: timeout.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new CpaWebError(
        `CPA API HTTP ${response.status}: ${clip(bodyText, 400)}`,
      );
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new CpaWebError("CPA API returned a non-JSON response.");
    }
  } catch (error) {
    if (error instanceof CpaWebError) throw error;
    throw new CpaWebError(
      `CPA API request failed: ${error?.message ?? String(error)}`,
      "WEB_PROVIDER_ERROR",
      { cause: error },
    );
  } finally {
    timeout.dispose();
  }
}

function looksEmptyHtml(content) {
  const visible = content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return visible.length < 40;
}

export class CpaSearchProvider {
  constructor(id, config, resolver) {
    this.id = id;
    this.config = config;
    this.resolver = resolver;
    this.title = "CPA Search";
    this.description = {
      en: "Searches the web through an OpenAI-compatible Responses endpoint with web_search_preview and returns answers with sources. Each search uses one model request.",
      zh: "通过 OpenAI 兼容的 Responses 接口和 web_search_preview 搜索网页，返回带来源的答案；每次搜索消耗一次模型请求。",
    };
  }

  available() {
    return Boolean(this.config.endpoint) && this.resolver.configured();
  }

  async ready() {
    return this.available();
  }

  async search(request, signal) {
    const query = String(request?.query ?? "").trim();
    if (!query) throw new CpaWebError("Missing search query.");
    const prompt =
      "Use web search to research the following query, then answer concisely " +
      "with citations. Do not answer from memory.\n\nQuery: " +
      query;
    const data = await postResponses(
      this.config,
      this.resolver,
      prompt,
      signal,
      this.config.searchTimeoutMs,
    );
    const { text, sources, truncated } = extractOutput(data, request?.maxResults);
    return {
      content: text || "CPA search returned no answer text.",
      sources,
      truncated,
    };
  }
}

export class CpaFetchProvider {
  constructor(id, config, resolver) {
    this.id = id;
    this.config = config;
    this.resolver = resolver;
    this.title = "CPA Fetch";
    this.description = {
      en: "Fetches static pages directly over HTTP(S), then falls back to model-mediated reading for empty, JavaScript, or login-walled pages.",
      zh: "直接通过 HTTP(S) 抓取静态页面；空正文、JavaScript 或登录墙页面回退到模型代读。",
    };
  }

  available() {
    return Boolean(this.config.endpoint) && this.resolver.configured();
  }

  async ready() {
    return this.available();
  }

  async fetch(request, signal) {
    const target = httpUrl(request?.url);
    try {
      const result = await this.fetchDirect(target, signal);
      if (
        this.config.readFallback &&
        result.body.kind === "html" &&
        looksEmptyHtml(result.body.content)
      ) {
        return await this.readViaModel(target, signal);
      }
      if (
        this.config.readFallback &&
        result.body.kind === "text" &&
        !result.body.content.trim()
      ) {
        return await this.readViaModel(target, signal);
      }
      return result;
    } catch (error) {
      if (!this.config.readFallback) throw error;
      return await this.readViaModel(target, signal, error);
    }
  }

  async fetchDirect(target, signal) {
    const timeout = withTimeout(signal, this.config.fetchTimeoutMs);
    try {
      const response = await fetch(target, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
          "Accept-Encoding": "identity",
        },
        signal: timeout.signal,
      });

      const bytes = new Uint8Array(await response.arrayBuffer());
      const truncatedByBytes = bytes.byteLength > this.config.maxBytes;
      const capped = bytes.slice(0, this.config.maxBytes);
      const contentType = (
        response.headers.get("content-type") ?? ""
      ).toLowerCase();
      const charset =
        /charset\s*=\s*"?([^";]+)/i.exec(contentType)?.[1]?.trim() || "utf-8";
      let text;
      try {
        text = new TextDecoder(charset, { fatal: false }).decode(capped);
      } catch {
        text = new TextDecoder("utf-8", { fatal: false }).decode(capped);
      }

      const isHtml =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml") ||
        (!contentType && /^\s*</.test(text));
      const isText =
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        contentType.includes("javascript") ||
        !contentType;

      let body;
      if (isHtml) {
        body = {
          kind: "html",
          content:
            text.length > this.config.maxChars
              ? text.slice(0, this.config.maxChars)
              : text,
        };
      } else if (isText) {
        body = {
          kind: "text",
          content:
            text.length > this.config.maxChars
              ? text.slice(0, this.config.maxChars)
              : text,
        };
      } else {
        throw new CpaWebError(
          `Unsupported content type "${contentType}" for ${target}.`,
          "WEB_UNSUPPORTED_CONTENT_TYPE",
        );
      }

      return {
        url: response.url || target,
        statusCode: response.status,
        body,
        truncated: truncatedByBytes || text.length > this.config.maxChars,
      };
    } catch (error) {
      if (error instanceof CpaWebError) throw error;
      throw new CpaWebError(
        `Fetch failed for ${target}: ${error?.message ?? String(error)}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    } finally {
      timeout.dispose();
    }
  }

  async readViaModel(target, signal, cause) {
    const prompt =
      "Read the web page at the URL below and return its main text content. " +
      "For a social post, return the post text verbatim and include any quoted " +
      "post or thread. Do not merely search for the URL or its ID; use the page " +
      "content. Keep the original language. If the page cannot be accessed, say " +
      `so explicitly.\n\nURL: ${target}`;
    try {
      const data = await postResponses(
        this.config,
        this.resolver,
        prompt,
        signal,
        this.config.fetchTimeoutMs,
      );
      const { text } = extractOutput(data);
      if (!text) {
        throw new CpaWebError(
          `CPA read returned no text for ${target}.`,
          "WEB_PROVIDER_ERROR",
          cause ? { cause } : undefined,
        );
      }
      return {
        url: target,
        statusCode: 200,
        body: {
          kind: "text",
          content:
            text.length > this.config.maxChars
              ? text.slice(0, this.config.maxChars)
              : text,
        },
        truncated: text.length > this.config.maxChars,
      };
    } catch (error) {
      if (error instanceof CpaWebError) throw error;
      throw new CpaWebError(
        `CPA read failed for ${target}: ${error?.message ?? String(error)}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
  }
}

export const name = "@douglarek/dsh-cpa-search-provider";
export const inject = ["web"];

export function apply(ctx, input) {
  const config = normalizeConfig(input);
  const resolver = new ApiKeyResolver(config.apiKey);

  ctx.effect(() => {
    const disposeSearch = ctx.web.registerSearchProvider(
      new CpaSearchProvider(config.searchProviderId, config, resolver),
    );
    const disposeFetch = ctx.web.registerFetchProvider(
      new CpaFetchProvider(config.fetchProviderId, config, resolver),
    );
    return () => {
      disposeFetch();
      disposeSearch();
    };
  }, `${name}: providers`);
}
