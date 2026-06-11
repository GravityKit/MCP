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

    // Auth resolution order: canonical GRAVITYKIT_WP_* (prod-style) →
    // WORDPRESS_LOCAL_DEV_TEST_* (the local dev.test admin creds; same
    // values reused by any other MonoKit tool that hits the local
    // install) → generic WP_USERNAME → GF MCP consumer key fallback.
    // The descriptive local-dev names exist so this single admin
    // credential isn't duplicated across every per-product env block.
    const username = this.config.GRAVITYKIT_WP_USERNAME
      || this.config.WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER
      || this.config.WP_USERNAME
      || this.config.GRAVITY_FORMS_CONSUMER_KEY;
    const password = this.config.GRAVITYKIT_WP_APP_PASSWORD
      || this.config.WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD
      || this.config.WP_APP_PASSWORD
      || this.config.GRAVITY_FORMS_CONSUMER_SECRET;
    if (!username || !password) {
      throw new Error('WordPress client requires credentials. Set GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD, or WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER + _ADMIN_PASSWORD, or reuse GRAVITY_FORMS_CONSUMER_KEY/SECRET.');
    }
    this.basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    this.allowSelfSigned = (this.config.GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS || this.config.MCP_ALLOW_SELF_SIGNED_CERTS) === 'true';
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
        'User-Agent': 'GravityKit-MCP/2.1.1',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': this.basicAuth,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: !this.allowSelfSigned }),
    });
  }
}

export default WordPressClient;
