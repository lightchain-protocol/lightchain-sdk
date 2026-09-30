import assert from 'node:assert/strict';
import { custom } from 'viem';

/** One HTTP exchange recorded against the Developer API. */
export type Exchange = { method: string; path: string; status: number; body?: unknown };

/**
 * A fetch that answers from recorded exchanges, in order, asserting each
 * request's method and path; `sent` keeps the requests for the test to check.
 */
export function replayHttp(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    sent.push({ method: request.method, path: url.pathname + url.search, headers: request.headers, body: text ? JSON.parse(text) : undefined });
    const next = queue.shift();
    assert.ok(next, `unexpected request ${request.method} ${url.pathname}`);
    assert.equal(`${request.method} ${url.pathname}`, `${next.method} ${next.path.split('?')[0]}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, sent, done: () => assert.equal(queue.length, 0, 'recorded exchanges left unused') };
}

/** One JSON-RPC call recorded against the chain. */
export type RpcCall = { method: string; params?: unknown; result: unknown };

/**
 * A viem transport that answers JSON-RPC calls from a recording: each method's
 * calls in the order they were recorded. `sent` keeps every call made.
 */
export function replayRpc(calls: RpcCall[]) {
  const queues = new Map<string, RpcCall[]>();
  for (const call of calls) queues.set(call.method, [...(queues.get(call.method) ?? []), call]);
  const sent: { method: string; params: unknown }[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      sent.push({ method, params });
      const queue = queues.get(method) ?? [];
      // The last answer of a method repeats: polls read the same state again.
      const next = queue.length > 1 ? queue.shift() : queue[0];
      assert.ok(next, `unexpected RPC call ${method}`);
      return next.result;
    },
  });
  return { transport, sent };
}
