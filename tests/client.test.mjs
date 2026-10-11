/**
 * The HTTP client: URL derivation, auth headers, error mapping, retries,
 * pagination and GraphQL.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiError, GitHubClient, nextLink } from '../src/client.js';

function response(body, { status = 200, headers = {} } = {}) {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowered.get(String(name).toLowerCase()) ?? null },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function stub(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { fetchImpl, calls };
}

test('github.com derives the public REST and GraphQL endpoints', () => {
  const client = new GitHubClient({ token: 't', fetchImpl: () => {} });
  assert.equal(client.apiBaseUrl, 'https://api.github.com');
  assert.equal(client.graphqlUrl, 'https://api.github.com/graphql');
  assert.equal(client.authenticated, true);
});

test('a GitHub Enterprise host derives /api/v3 and /api/graphql', () => {
  const client = new GitHubClient({ token: 't', host: 'ghe.example.com', fetchImpl: () => {} });
  assert.equal(client.apiBaseUrl, 'https://ghe.example.com/api/v3');
  assert.equal(client.graphqlUrl, 'https://ghe.example.com/api/graphql');
});

test('requests carry the versioned accept header and the bearer token', async () => {
  const { fetchImpl, calls } = stub(() => response({ login: 'octocat' }));
  const client = new GitHubClient({ token: 'secret', fetchImpl });
  const user = await client.get('/user');
  assert.deepEqual(user, { login: 'octocat' });
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers['x-github-api-version'], '2022-11-28');
});

test('an unauthenticated client sends no authorization header', async () => {
  const { fetchImpl, calls } = stub(() => response({}));
  const client = new GitHubClient({ fetchImpl });
  await client.get('/user');
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(client.authenticated, false);
});

test('restUrl drops empty values and repeats arrays', () => {
  const client = new GitHubClient({ fetchImpl: () => {} });
  const url = client.restUrl('/search/code', { q: 'x', sort: undefined, page: 1, labels: ['a', 'b'] });
  assert.equal(url, 'https://api.github.com/search/code?q=x&page=1&labels=a&labels=b');
});

test('a failing response becomes a GitHubApiError with its context', async () => {
  const { fetchImpl } = stub(() => response({ message: 'Not Found', errors: [{ message: 'nope' }] }, { status: 404 }));
  const client = new GitHubClient({ token: 't', retries: 0, fetchImpl });
  await assert.rejects(
    () => client.get('/repos/o/r'),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 404);
      assert.equal(error.message, 'Not Found');
      assert.equal(error.method, 'GET');
      assert.match(error.toToolMessage(), /Not Found/);
      return true;
    },
  );
});

test('retryable statuses are retried and then succeed', async () => {
  const { fetchImpl, calls } = stub((_url, _init, attempt) =>
    attempt === 1 ? response({ message: 'boom' }, { status: 500 }) : response({ ok: true }),
  );
  const client = new GitHubClient({ token: 't', retries: 1, fetchImpl });
  const result = await client.get('/user');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
});

test('a 422 is never retried', async () => {
  const { fetchImpl, calls } = stub(() => response({ message: 'Validation Failed' }, { status: 422 }));
  const client = new GitHubClient({ token: 't', retries: 3, fetchImpl });
  await assert.rejects(() => client.get('/user'), /Validation Failed/);
  assert.equal(calls.length, 1);
});

test('paginate follows Link rel=next', async () => {
  const { fetchImpl, calls } = stub((url) => {
    if (/[?&]page=2/.test(url)) return response([{ id: 3 }]);
    return response([{ id: 1 }, { id: 2 }], {
      headers: { link: '<https://api.github.com/items?page=2>; rel="next"' },
    });
  });
  const client = new GitHubClient({ token: 't', fetchImpl });
  const items = await client.paginate('/items', { perPage: 2, maxItems: 10 });
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(calls.length, 2);
});

test('paginate stops at maxItems', async () => {
  const { fetchImpl } = stub((url) =>
    response([{ id: 1 }, { id: 2 }], { headers: { link: `<${url.split('?')[0]}?page=2>; rel="next"` } }),
  );
  const client = new GitHubClient({ token: 't', fetchImpl });
  const items = await client.paginate('/items', { perPage: 2, maxItems: 3 });
  assert.equal(items.length, 3);
});

test('search returns the GitHub envelope', async () => {
  const { fetchImpl, calls } = stub(() =>
    response({ total_count: 2, incomplete_results: false, items: [{ number: 1 }, { number: 2 }] }),
  );
  const client = new GitHubClient({ token: 't', fetchImpl });
  const result = await client.search('/search/issues', { query: { q: 'x' }, maxItems: 30, perPage: 30 });
  assert.equal(result.total_count, 2);
  assert.equal(result.incomplete_results, false);
  assert.equal(result.items.length, 2);
  assert.match(calls[0].url, /per_page=30/);
});

test('graphql posts the query and variables', async () => {
  const { fetchImpl, calls } = stub(() => response({ data: { viewer: { login: 'octocat' } } }));
  const client = new GitHubClient({ token: 't', fetchImpl });
  const data = await client.graphql('query { viewer { login } }', { a: 1 });
  assert.deepEqual(data, { viewer: { login: 'octocat' } });
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'query { viewer { login } }', variables: { a: 1 } });
});

test('graphql errors throw and keep the partial data', async () => {
  const { fetchImpl } = stub(() =>
    response({ data: { viewer: null }, errors: [{ message: 'Something went wrong' }] }),
  );
  const client = new GitHubClient({ token: 't', fetchImpl });
  await assert.rejects(
    () => client.graphql('query { viewer { login } }'),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.match(error.message, /Something went wrong/);
      assert.deepEqual(error.data, { viewer: null });
      return true;
    },
  );
});

test('graphqlPages walks cursors until the last page', async () => {
  const { fetchImpl } = stub((_url, init) => {
    const { variables } = JSON.parse(init.body);
    if (variables.cursor === null) {
      return response({ data: { items: { nodes: [{ id: 1 }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } });
    }
    return response({ data: { items: { nodes: [{ id: 2 }], pageInfo: { hasNextPage: false, endCursor: 'c2' } } } });
  });
  const client = new GitHubClient({ token: 't', fetchImpl });
  const nodes = await client.graphqlPages('query($cursor: String) { items { nodes { id } } }', {}, (data) => data?.items);
  assert.deepEqual(nodes, [{ id: 1 }, { id: 2 }]);
});

test('getText requests the raw media type', async () => {
  const { fetchImpl, calls } = stub(() => response('hello'));
  const client = new GitHubClient({ token: 't', fetchImpl });
  const text = await client.getText('/repos/o/r/contents/README.md');
  assert.equal(text, 'hello');
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github.raw');
});

test('nextLink parses the Link header', () => {
  assert.equal(nextLink(null), null);
  assert.equal(
    nextLink('<https://api.github.com/items?page=2>; rel="next", <https://api.github.com/items?page=5>; rel="last"'),
    'https://api.github.com/items?page=2',
  );
  assert.equal(nextLink('<https://api.github.com/items?page=1>; rel="prev"'), null);
});
