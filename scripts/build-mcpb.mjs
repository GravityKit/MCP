#!/usr/bin/env node
/**
 * Build the Claude Desktop extension (.mcpb) from the published package contents.
 *
 * The bundle must be self-contained: Claude Desktop runs `node <bundle>/src/index.js`
 * with its own Node runtime and never installs anything, so production dependencies
 * ship inside the bundle's node_modules.
 *
 * Staging is built from `npm pack` output rather than the working tree so the bundle
 * carries exactly what the npm `files` allowlist ships — no tests, scripts, or bench.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectRoot, 'build');

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

// A version mismatch ships a bundle whose reported version doesn't match its code.
if (manifest.version !== pkg.version) {
  throw new Error(`Version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'gkmcp-mcpb-'));

try {
  // `npm pack` applies the `files` allowlist, so the tarball is the shipped surface.
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', staging], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();

  run('tar', ['-xzf', path.join(staging, tarball), '-C', staging]);

  // npm's tarball root is always "package/".
  const bundleDir = path.join(staging, 'package');
  fs.copyFileSync(path.join(projectRoot, 'manifest.json'), path.join(bundleDir, 'manifest.json'));

  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], bundleDir);

  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `gravitykit-mcp-${manifest.version}.mcpb`);

  run('npx', ['-y', '@anthropic-ai/mcpb', 'validate', path.join(bundleDir, 'manifest.json')], projectRoot);
  run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', bundleDir, output], projectRoot);

  console.log(`\nBuilt ${output}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
