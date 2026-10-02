// Writes test/fixtures/openapi.json: the /v1/chat/completions part of the
// consumer API's /docs/json, built from the consumer-api submodule's source
// and read by injection, no server listening. Run from sdk/ with consumer-api's
// dependencies installed: `npm run openapi` (it runs under consumer-api's tsx).
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const API = new URL('../../consumer-api/', import.meta.url);
// The env schema exits without these; nothing the document says depends on them.
process.env.DATABASE_URL ??= 'postgres://unused/unused';
process.env.DISPATCHER_INTERNAL_AUTH_SECRET ??= 'unused';
process.env.DISPATCHER_JWT_PUBLIC_KEY_HEX ??= `02${'00'.repeat(32)}`;
process.env.CHAIN_ID ??= '1';

// Loaded from consumer-api, by computed paths, so this package's tsc stays out of its source.
const load = async (path: string) => (await import(new URL(path, API).href)).default;
const Fastify = createRequire(API)('fastify');
const app = Fastify({ logger: false });
app.decorate('redis', {});
await app.register(await load('src/plugins/swagger.plugin.ts'));
await app.register(await load('src/routes/v1/index.ts'));
const { openapi, info, paths } = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
await app.close();

const path = '/v1/chat/completions';
writeFileSync('test/fixtures/openapi.json', `${JSON.stringify({ openapi, info, paths: { [path]: paths[path] } }, null, 2)}\n`);
