/**
 * OpenAPI snapshot generator (T26): writes the generated contract to
 * `openapi.json` at the repo root — the committed, reviewable snapshot
 * that the CI drift gate (`generate → git diff --exit-code`) locks against
 * the registry. Any registry change that leaves the snapshot stale turns
 * the build red, and the resulting diff is visible in the PR.
 *
 * Uses exactly the canonical platform inputs — the v1 platform action set
 * and `DEFAULT_OPENAPI_META` — so the snapshot and the default-served
 * `GET /openapi.json` document can never disagree.
 *
 * Usage:
 *   npm run generate:openapi
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildPlatformOpenApiDocument,
  CONNECTION_ACTIONS,
  DOCS_ACTIONS,
} from '../src/index.js';

const document = buildPlatformOpenApiDocument([...DOCS_ACTIONS, ...CONNECTION_ACTIONS]);
const snapshotPath = fileURLToPath(new URL('../openapi.json', import.meta.url));
writeFileSync(snapshotPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${snapshotPath}`);
