/**
 * client.js — the GitHub API client shared by every tool handler.
 *
 * Two surfaces:
 *   - REST v3 (`api.github.com` on github.com, `/{host}/api/v3` on GitHub Enterprise)
 *   - GraphQL v4 (`api.github.com/graphql`, `/{host}/api/graphql`)
 *
 * Deliberately dependency-free: the plugin runs inside the harness process and
 * uses the platform `fetch`.
 */

export class GitHubApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = details.status ?? null;
    this.method = details.method ?? null;
    this.url = details.url ?? null;
    this.body = details.body ?? null;
    this.errors = details.errors ?? null;
    this.requestId = details.requestId ?? null;
    this.rateLimitRemaining = details.rateLimitRemaining ?? null;
    this.rateLimitReset = details.rateLimitReset ?? null;
    this.retryAfter = details.retryAfter ?? null;
  }

  /** A message intended for the model: what failed, where, and what GitHub said. */
  toToolMessage() {
    const parts = [`GitHub API error${this.status ? ` (HTTP ${this.status})` : ''}: ${this.message}`];
    if (this.method && this.url) parts.push(`${this.method} ${this.url}`);
    if (this.errors && Array.isArray(this.errors) && this.errors.length > 0) {
      const rendered = this.errors
        .map((entry) => (typeof entry === 'string' ? entry : entry?.message ?? JSON.stringify(entry)))
        .filter(Boolean)
        .join('; ');
      if (rendered) parts.push(rendered);
    }
    if (this.status === 401) parts.push('The configured GitHub token was rejected. Check the token value and its scopes.');
    if (this.status === 403 && this.rateLimitRemaining === '0') {
      parts.push(`Rate limit exhausted; it resets at ${this.rateLimitReset ? new Date(Number(this.rateLimitReset) * 1000).toISOString() : 'an unknown time'}.`);
    }
    if (this.status === 404) parts.push('The resource was not found, or the token cannot see it (GitHub reports 404 for both).');
    if (this.requestId) parts.push(`request id: ${this.requestId}`);
    return parts.join('\n');
  }
}

/** Parse a Link header and return the `rel="next"` URL, if any. */
function nextLink(header) {
  if (!header) return null;
  for (const part of String(header).split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const DEFAULT_USER_AGENT = 'dsh-github-tools/1.0.0';

export class GitHubClient {
  /**
   * @param {object} options
   * @param {string|null} options.token      personal access token (or GitHub App installation token)
   * @param {string} [options.host]          `github.com` or a GitHub Enterprise host
   * @param {string} [options.apiBaseUrl]    overrides the REST base derived from `host`
   * @param {string} [options.graphqlUrl]    overrides the GraphQL endpoint derived from `host`
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]
   * @param {string} [options.userAgent]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.token = options.token ?? null;
    this.host = (options.host || 'github.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.apiBaseUrl = (options.apiBaseUrl || this.#deriveApiBaseUrl()).replace(/\/+$/, '');
    this.graphqlUrl = options.graphqlUrl || this.#deriveGraphqlUrl();
    this.uploadsBaseUrl = this.host === 'github.com' ? 'https://uploads.github.com' : `https://${this.host}/api/uploads`;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000;
    this.retries = Number.isFinite(options.retries) ? Math.max(0, options.retries) : 2;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    /** Optional observer hook: (info) => void, used by tests. */
    this.onRequest = typeof options.onRequest === 'function' ? options.onRequest : null;
  }

  get authenticated() {
    return typeof this.token === 'string' && this.token.length > 0;
  }

  #deriveApiBaseUrl() {
    if (this.host === 'github.com') return 'https://api.github.com';
    if (this.host === 'api.github.com') return 'https://api.github.com';
    return `https://${this.host}/api/v3`;
  }

  #deriveGraphqlUrl() {
    if (this.host === 'github.com' || this.host === 'api.github.com') return 'https://api.github.com/graphql';
    return `https://${this.host}/api/graphql`;
  }

  #headers(extra = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': this.userAgent,
      'x-github-api-version': '2022-11-28',
      ...extra,
    };
    if (this.authenticated) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** Build an absolute REST URL from a path (with or without a leading slash). */
  restUrl(path, query) {
    const base = /^https?:\/\//.test(path) ? path : `${this.apiBaseUrl}/${String(path).replace(/^\/+/, '')}`;
    if (!query) return base;
    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Low-level request. Returns the raw `Response` plus decoded text/json so
   * callers can inspect headers (Link, X-RateLimit-*) as well as the body.
   */
  async request(method, path, { query, body, headers, raw = false, absolute = false, signal, expectText = false } = {}) {
    const url = absolute ? path : this.restUrl(path, query);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const composed = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, signal]) : timeout;
      const init = {
        method,
        headers: this.#headers(raw ? { ...headers, accept: headers?.accept ?? 'application/vnd.github.raw' } : headers),
        signal: composed,
      };
      if (body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        if (typeof body !== 'string' && !init.headers['content-type']) init.headers['content-type'] = 'application/json';
      }
      this.onRequest?.({ method, url, attempt });
      let response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new GitHubApiError(`request timed out after ${this.timeoutMs}ms`, { method, url, body: null });
        }
        throw new GitHubApiError(`network request failed: ${error?.message ?? error}`, { method, url });
      }

      const text = await response.text();
      if (response.ok) {
        let json;
        if (!expectText) {
          try {
            json = text.length === 0 ? null : JSON.parse(text);
          } catch {
            json = undefined;
          }
        }
        return { response, status: response.status, text, json, url, method };
      }

      const retryAfter = response.headers.get('retry-after');
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const retryable = isRetryableStatus(response.status) && attempt < this.retries;
      if (retryable) {
        attempt += 1;
        const backoff = retryAfter ? Number(retryAfter) * 1000 : Math.min(2 ** attempt * 250, 4_000);
        await sleep(Number.isFinite(backoff) && backoff > 0 ? backoff : 500);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const message = parsed?.message || (text.length > 0 ? text.slice(0, 500) : `HTTP ${response.status}`);
      throw new GitHubApiError(message, {
        status: response.status,
        method,
        url,
        body: parsed ?? text.slice(0, 2_000),
        errors: parsed?.errors ?? null,
        requestId: response.headers.get('x-github-request-id'),
        rateLimitRemaining,
        rateLimitReset: response.headers.get('x-ratelimit-reset'),
        retryAfter,
      });
    }
  }

  /** REST call returning the decoded JSON body (or raw text when `expectText`). */
  async rest(method, path, options = {}) {
    const { json, text, expectText } = await this.request(method, path, options);
    if (expectText) return text;
    return json;
  }

  get(path, options) {
    return this.rest('GET', path, options);
  }

  post(path, body, options) {
    return this.rest('POST', path, { ...options, body });
  }

  patch(path, body, options) {
    return this.rest('PATCH', path, { ...options, body });
  }

  put(path, body, options) {
    return this.rest('PUT', path, { ...options, body });
  }

  delete(path, body, options) {
    return this.rest('DELETE', path, body === undefined ? options : { ...options, body });
  }

  /** Fetch raw text/bytes as a string (for file contents, diffs, logs). */
  async getText(path, options = {}) {
    const { text } = await this.request('GET', path, { ...options, raw: true, expectText: true });
    return text;
  }

  /**
   * Follow `Link: rel="next"` pagination, collecting items.
   * @param {string} path
   * @param {object} options `{ query, maxItems, perPage, extract }`
   */
  async paginate(path, options = {}) {
    const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : Number.POSITIVE_INFINITY;
    const perPage = options.perPage ?? 100;
    const extract = options.extract ?? ((body) => (Array.isArray(body) ? body : body?.items ?? []));
    const collected = [];
    let url = this.restUrl(path, { ...options.query, per_page: perPage });
    let guard = 0;
    while (url && collected.length < maxItems && guard < 100) {
      guard += 1;
      const { json, response, url: requested } = await this.request('GET', url, { absolute: true, signal: options.signal });
      const page = extract(json) ?? [];
      for (const item of page) {
        if (collected.length >= maxItems) break;
        collected.push(item);
      }
      url = nextLink(response.headers.get('link'));
      if (page.length === 0) break;
      if (url === null && options.once !== true) break;
      void requested;
    }
    return collected;
  }

  /** REST search endpoint: returns `{ total_count, incomplete_results, items }`. */
  async search(path, options = {}) {
    const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 100;
    const perPage = Math.min(options.perPage ?? 30, 100);
    const items = [];
    let totalCount = 0;
    let incomplete = false;
    let url = this.restUrl(path, { ...options.query, per_page: perPage });
    let guard = 0;
    while (url && items.length < maxItems && guard < 20) {
      guard += 1;
      const { json, response } = await this.request('GET', url, { absolute: true, signal: options.signal });
      if (json && typeof json === 'object') {
        totalCount = typeof json.total_count === 'number' ? json.total_count : totalCount;
        incomplete = Boolean(json.incomplete_results);
        for (const item of json.items ?? []) {
          if (items.length >= maxItems) break;
          items.push(item);
        }
        if ((json.items ?? []).length === 0) break;
      }
      url = nextLink(response.headers.get('link'));
    }
    return { total_count: totalCount, incomplete_results: incomplete, items };
  }

  /** Single GraphQL v4 call. Throws `GitHubApiError` when the response carries `errors`. */
  async graphql(query, variables = {}, options = {}) {
    const { json } = await this.request('POST', this.graphqlUrl, {
      absolute: true,
      body: { query, variables },
      signal: options.signal,
      headers: { 'content-type': 'application/json' },
    });
    if (json && Array.isArray(json.errors) && json.errors.length > 0) {
      const error = new GitHubApiError(json.errors.map((entry) => entry.message).join('; '), {
        method: 'POST',
        url: this.graphqlUrl,
        body: json,
        errors: json.errors,
      });
      // A partial response with `data` is still useful to some callers.
      error.data = json.data ?? null;
      if (json.data == null || options.strict !== false) throw error;
    }
    return json?.data ?? null;
  }

  /**
   * Walk a GraphQL connection by feeding `pageInfo.endCursor` back into the
   * query as `$cursor`. The caller supplies `select(data)` returning the
   * connection object `{ nodes, pageInfo }`.
   */
  async graphqlPages(query, variables, select, options = {}) {
    const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 1_000;
    const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : 20;
    const collected = [];
    let cursor = options.cursor ?? null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.graphql(query, { ...variables, cursor }, options);
      const connection = select(data);
      if (!connection) break;
      for (const node of connection.nodes ?? []) {
        if (collected.length >= maxItems) return collected;
        collected.push(node);
      }
      if (!connection.pageInfo?.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
    }
    return collected;
  }

  /** GraphQL totalCount companion for `graphqlPages`. */
  async graphqlTotalCount(query, variables, select, options = {}) {
    const data = await this.graphql(query, { ...variables, cursor: null }, options);
    const connection = select(data);
    return connection?.totalCount ?? 0;
  }
}

export { nextLink };
