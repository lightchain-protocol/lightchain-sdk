// Writes test/fixtures/openapi.json: the /v1/chat/completions part of the
// Developer API's OpenAPI document, as the network's API serves it.
//
//   LIGHTCHAIN_NETWORK=testnet npm run openapi
import { writeFileSync } from 'node:fs';
import { networks } from '../src/index.ts';

const { apiUrl } = networks[(process.env.LIGHTCHAIN_NETWORK ?? 'testnet') as keyof typeof networks];
const res = await fetch(`${apiUrl}/docs/json`);
if (!res.ok) throw new Error(`${apiUrl}/docs/json: ${res.status}`);
const { openapi, info, paths } = await res.json();

const path = '/v1/chat/completions';
const fixture = { openapi, info, paths: { [path]: paths[path] } };
writeFileSync('test/fixtures/openapi.json', `${JSON.stringify(fixture, null, 2)}\n`);
