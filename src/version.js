/**
 * Single source of truth for the package version and User-Agent.
 * Read from package.json so the clients never drift from the released version.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

export const VERSION = pkg.version;
export const USER_AGENT = `GravityKit-MCP/${VERSION}`;
