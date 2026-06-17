/**
 * Siteminter provider — mint a fresh, fully-configured target for the gate.
 *
 * Why: the abilities API (gv_*) needs a real WordPress user (application
 * password), not a Gravity Forms API key, and it needs WP 6.9+ (the abilities
 * REST routes). A disposable siteminter site gives all of that AND symlinks the
 * GravityView / Gravity Forms source UNDER TEST, so the gate exercises the
 * actual code. One admin application password authenticates both planes
 * (GF REST + abilities).
 *
 * Foundation note: we mint GF + GravityView only — NOT the standalone Foundation
 * plugin. GravityView bundles Foundation, and with no competing copy its bundled
 * Foundation wins and registers `GravityKitFoundation`, so the code under test
 * (e.g. Manager's input_schema default) is the code that actually runs.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SITEMINTER } from '../config.mjs';

function sm(args, { json = false } = {}) {
  const res = spawnSync('npm', ['run', '--silent', 'cli', '--', ...args], {
    cwd: SITEMINTER.dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}`;
  if (res.status !== 0 && !json) {
    throw new Error(`siteminter ${args[0]} failed: ${(res.stderr || out).slice(-400)}`);
  }
  if (!json) return out;
  const match = out.match(/\{[\s\S]*\}/); // tolerate any stray npm prefix
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/** Run wp-cli inside a minted site via its wp-env, returning trimmed stdout. */
function wpCli(sitePath, wpArgs) {
  const wpEnv = join(SITEMINTER.dir, 'node_modules', '.bin', 'wp-env');
  const res = spawnSync(wpEnv, ['run', 'cli', 'wp', ...wpArgs], {
    cwd: sitePath,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`wp ${wpArgs.join(' ')} failed: ${(res.stderr || res.stdout || '').slice(-400)}`);
  }
  return `${res.stdout || ''}`.trim();
}

/** Site info ({name,path,port,url,...}) or null if it doesn't exist yet. */
export function siteInfo(name = SITEMINTER.siteName) {
  return sm(['info', name, '--json'], { json: true });
}

/**
 * Active plugins on a minted site as { slug: version }. Used to PROVE a
 * validation ran against the real add-ons (not stubs) before trusting it.
 *
 * @param {string} sitePath
 * @returns {Record<string,string>}
 */
export function activePlugins(sitePath) {
  const raw = wpCli(sitePath, ['plugin', 'list', '--status=active', '--fields=name,version', '--format=json']);
  const out = {};
  try {
    for (const p of JSON.parse(raw)) out[p.name] = p.version;
  } catch { /* tolerate format drift */ }
  return out;
}

/**
 * Ensure the bench site exists + is provisioned, returning a target the gate
 * can run against. Reuses an existing site unless `fresh` is set.
 *
 * @param {{fresh?:boolean, log?:(m:string)=>void, name?:string, plugins?:string[]}} [opts]
 *   name/plugins override the release-gate defaults (e.g. the field-storage
 *   suite mints a distinct site that also includes the real add-on plugins).
 * @returns {Promise<{target:object, name:string, path:string, minted:boolean}>}
 */
export async function provisionSite({ fresh = false, log = () => {}, name = SITEMINTER.siteName, plugins = SITEMINTER.plugins } = {}) {
  if (!SITEMINTER.dir) throw new Error('SITEMINTER_DIR is not set and siteminter could not be located.');

  let info = siteInfo(name);
  if (info && fresh) {
    log(`Destroying existing site "${name}" for a fresh mint…`);
    sm(['destroy', name, '--yes']);
    info = null;
  }

  let minted = false;
  if (!info) {
    log(`Minting "${name}" with: ${plugins.join(', ')} (first mint pulls Docker images — slow)…`);
    sm(['mint', `--name=${name}`, `--plugins=${plugins.join(',')}`]);
    minted = true;
    info = siteInfo(name);
    if (!info) throw new Error(`mint succeeded but info for "${name}" is unavailable`);
  } else {
    log(`Reusing existing site "${name}" at ${info.url}`);
  }

  // One admin application password authenticates GF REST AND the abilities API.
  log('Creating an admin application password…');
  const appPassword = wpCli(info.path, ['user', 'application-password', 'create', 'admin', 'gvbench', '--porcelain']);
  if (!appPassword) throw new Error('failed to create an application password');

  // Best-effort: enable GF REST API so gf_* validate against the site. gv_*
  // (abilities) don't need this — they auth with the app password directly.
  try {
    wpCli(info.path, ['eval', "$s=(array)get_option('gravityformsaddon_gravityformswebapi_settings');$s['enabled']=1;update_option('gravityformsaddon_gravityformswebapi_settings',$s);echo 'ok';"]);
  } catch { /* GF webapi settings vary by version; gf_* may need manual enable */ }

  const target = {
    baseUrl: info.url,
    key: 'admin',
    secret: appPassword,
    wpUrl: info.url,
    wpUser: 'admin',
    wpPass: appPassword,
    allowSelfSigned: false, // siteminter serves plain http on localhost
  };
  return { target, name, path: info.path, minted };
}

/** Tear a minted site down (skip when the caller wants to inspect it). */
export function destroySite(name = SITEMINTER.siteName) {
  sm(['destroy', name, '--yes']);
}
