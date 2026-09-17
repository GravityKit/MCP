/**
 * Authenticated WordPress transport for GravityKit MCP.
 *
 * Product-agnostic: this is the client the abilities loader rides to
 * reach the Foundation catalog (`/wp-json/gravitykit/v1/...`), the WP
 * core Abilities API (`/wp-json/wp-abilities/v1/...`), and any other
 * WP-root REST surface. Product-specific clients (e.g. the GravityView
 * Inspector test client) extend it and add their own namespace.
 *
 * Authentication: WordPress Application Password via HTTP Basic Auth.
 * The same WP install usually hosts the GF REST surface too, so when
 * GRAVITYKIT_WP_* credentials aren't set we fall back to
 * GRAVITY_FORMS_CONSUMER_KEY / GRAVITY_FORMS_CONSUMER_SECRET (which in
 * practice are usually a WP user + app password as well — most
 * local-dev setups reuse them rather than minting two credentials).
 */

import axios from 'axios';
import https from 'https';
import { USER_AGENT } from './version.js';
import { isLocalUrl } from './config/auth.js';

export class WordPressClient {
  constructor(config) {
    this.config = config || {};

    const baseUrl = this.resolveBaseUrl();
    if (!baseUrl) {
      throw new Error('WordPress client requires GRAVITYKIT_WP_URL or GRAVITY_FORMS_BASE_URL.');
    }
    if (!baseUrl.startsWith('https://') && !baseUrl.startsWith('http://')) {
      throw new Error('WordPress base URL must start with http:// or https://');
    }

    this.baseUrl = baseUrl.replace(/\/$/, '');

    // This client always sends Basic auth (app password). Refuse to do that
    // over a remote plain-HTTP URL — the credentials would travel in the
    // clear. Local dev hosts (localhost, *.test, *.local) are fine; an
    // explicit GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=true overrides. Mirrors
    // the Gravity Forms plane's guard (config/auth.js).
    const allowHttpBasic = isLocalUrl(this.baseUrl)
      || this.config.GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH === 'true';
    if (this.baseUrl.startsWith('http://') && !allowHttpBasic) {
      throw new Error('Refusing to send Basic auth over a remote plain-HTTP URL — credentials would be exposed. Use HTTPS, or set GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=true to override.');
    }

    // Auth resolution order: canonical GRAVITYKIT_WP_* (prod-style) →
    // WORDPRESS_LOCAL_DEV_TEST_* (the local dev.test admin creds; same
    // values reused by any other MonoKit tool that hits the local
    // install) → generic WP_USERNAME → GF MCP consumer key fallback.
    // The descriptive local-dev names exist so this single admin
    // credential isn't duplicated across every per-product env block.
    // Each source is taken WHOLE. Resolving the two halves independently pairs a
    // username from one source with a secret from another whenever a source is
    // half-configured, and the 401 that follows reads as a wrong password rather
    // than as the environment being incomplete.
    const sources = [
      ['GRAVITYKIT_WP_USERNAME', 'GRAVITYKIT_WP_APP_PASSWORD'],
      ['WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER', 'WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD'],
      ['WP_USERNAME', 'WP_APP_PASSWORD'],
      ['GRAVITY_FORMS_CONSUMER_KEY', 'GRAVITY_FORMS_CONSUMER_SECRET'],
    ];

    const complete = sources.find(([user, pass]) => this.config[user] && this.config[pass]);

    if (!complete) {
      // Name the half-configured source rather than listing every option: a
      // username set with no password is the case this is most often reached in.
      const partial = sources.find(([user, pass]) => this.config[user] || this.config[pass]);
      const detail = partial
        ? ` ${partial[0]} and ${partial[1]} must both be set; only one of them is.`
        : '';

      throw new Error(`WordPress client requires credentials. Set GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD, or WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER + _ADMIN_PASSWORD, or reuse GRAVITY_FORMS_CONSUMER_KEY/SECRET.${detail}`);
    }

    // Recorded so `gk_reload_abilities` can say which site and which credentials
    // this plane resolved: the two planes rank their base URLs differently and
    // can end up pointed at different installs.
    this.credentialSource = `${complete[0]} + ${complete[1]}`;
    this.basicAuth = 'Basic ' + Buffer.from(`${this.config[complete[0]]}:${this.config[complete[1]]}`).toString('base64');

    // Compare each flag on its own: `A || B` short-circuits on a truthy string
    // like 'false', so one flag could otherwise mask the other.
    this.allowSelfSigned =
      this.config.GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS === 'true' ||
      this.config.MCP_ALLOW_SELF_SIGNED_CERTS === 'true';
    this.timeoutMs = parseInt(this.config.GRAVITYKIT_TIMEOUT || this.config.GRAVITY_FORMS_TIMEOUT, 10) || 30000;

    // Rooted at the WP install. Subclasses may replace this with a
    // namespaced instance via createHttpClient(); callers that need a
    // different root per request (the abilities loader) pass an
    // explicit `baseURL` in the request config, which wins either way.
    this.httpClient = this.createHttpClient(this.baseUrl);
  }

  resolveBaseUrl() {
    return this.config.GRAVITYKIT_WP_URL
      || this.config.WORDPRESS_LOCAL_DEV_TEST_URL
      || this.config.GRAVITY_FORMS_BASE_URL
      || '';
  }

  /**
   * Build an axios instance carrying this client's auth, timeout, and
   * TLS settings. Subclasses use it to mount namespaced clients.
   *
   * @param {string} baseURL Absolute base URL for the instance.
   * @returns {import('axios').AxiosInstance}
   */
  createHttpClient(baseURL) {
    return axios.create({
      baseURL,
      timeout: this.timeoutMs,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': this.basicAuth,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: !this.allowSelfSigned }),
    });
  }
}

export default WordPressClient;
