/**
 * Gravity Forms Authentication Module
 * Supports Basic Authentication (primary) and OAuth 1.0a (secondary)
 *
 * Basic Authentication is prioritized per Gravity Forms v2 recommendations
 * OAuth 1.0a included for advanced security requirements
 */

import crypto from 'crypto';
import logger from '../utils/logger.js';

/**
 * Basic Authentication Handler (PRIMARY METHOD)
 * Simple and secure authentication using Consumer Key/Secret over HTTPS
 * Recommended for Gravity Forms v2 REST API
 */
export class BasicAuthHandler {
  constructor(consumerKey, consumerSecret, baseUrl) {
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.baseUrl = baseUrl;

    // Validate HTTPS for Basic Auth security
    if (!this.baseUrl.startsWith('https://')) {
      throw new Error('Basic Authentication requires HTTPS connection for security');
    }
  }

  /**
   * Generate Basic Auth headers for Gravity Forms v2
   * Uses standard HTTP Basic Authentication with Consumer Key/Secret
   */
  getAuthHeaders() {
    const credentials = `${this.consumerKey}:${this.consumerSecret}`;
    const encodedCredentials = Buffer.from(credentials).toString('base64');

    return {
      'Authorization': `Basic ${encodedCredentials}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Gravity MCP v1.0.0'
    };
  }

  /**
   * Test authentication by making a simple API call
   * Validates both credentials and REST API availability
   */
  async testConnection(httpClient) {
    try {
      const response = await httpClient.get('/forms', {
        headers: this.getAuthHeaders(),
        params: { per_page: 1 }
      });

      return {
        success: true,
        method: 'Basic Authentication',
        message: 'Successfully connected to Gravity Forms REST API v2',
        version: response.data.version || 'Unknown'
      };
    } catch (error) {
      return {
        success: false,
        method: 'Basic Authentication',
        error: error.response?.status === 401 ? 'Invalid credentials' : error.message,
        details: error.response?.data || error.message
      };
    }
  }
}

/**
 * OAuth 1.0a Authentication Handler (SECONDARY METHOD)
 * More complex but provides additional security features
 * Included for environments requiring OAuth workflow
 */
export class OAuth1Handler {
  constructor(consumerKey, consumerSecret, baseUrl) {
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.baseUrl = baseUrl;
  }

  /**
   * Generate OAuth 1.0a signature for Gravity Forms API
   * Implements RFC 5849 OAuth 1.0a specification
   */
  generateOAuthSignature(method, url, params, timestamp, nonce) {
    // Validate required parameters
    if (!method || !url || !timestamp || !nonce) {
      throw new Error('Invalid OAuth parameters: method, url, timestamp, and nonce are required');
    }

    // Combine all parameters
    const allParams = {
      ...params,
      oauth_consumer_key: this.consumerKey,
      oauth_timestamp: timestamp,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_version: '1.0'
    };

    // Create parameter string
    const paramString = Object.keys(allParams)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(allParams[key])}`)
      .join('&');

    // Create signature base string
    const baseString = [
      method.toUpperCase(),
      encodeURIComponent(url),
      encodeURIComponent(paramString)
    ].join('&');

    // Create signing key
    const signingKey = `${encodeURIComponent(this.consumerSecret)}&`;

    // Generate signature
    const signature = crypto
      .createHmac('sha1', signingKey)
      .update(baseString)
      .digest('base64');

    return signature;
  }

  /**
   * Generate OAuth 1.0a headers for API request
   */
  getAuthHeaders(method = 'GET', url, params = {}) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const signature = this.generateOAuthSignature(method, url, params, timestamp, nonce);

    const authHeader = [
      `oauth_consumer_key="${encodeURIComponent(this.consumerKey)}"`,
      `oauth_timestamp="${timestamp}"`,
      `oauth_nonce="${nonce}"`,
      `oauth_signature_method="HMAC-SHA1"`,
      `oauth_version="1.0"`,
      `oauth_signature="${encodeURIComponent(signature)}"`
    ].join(', ');

    return {
      'Authorization': `OAuth ${authHeader}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Gravity MCP v1.0.0'
    };
  }

  /**
   * Test OAuth authentication
   */
  async testConnection(httpClient) {
    try {
      const fullUrl = `${this.baseUrl}/wp-json/gf/v2/forms`;
      const headers = this.getAuthHeaders('GET', fullUrl, { per_page: 1 });

      const response = await httpClient.get('/forms', {
        headers,
        params: { per_page: 1 }
      });

      return {
        success: true,
        method: 'OAuth 1.0a',
        message: 'Successfully connected to Gravity Forms REST API v2',
        version: response.data.version || 'Unknown'
      };
    } catch (error) {
      return {
        success: false,
        method: 'OAuth 1.0a',
        error: error.response?.status === 401 ? 'Invalid OAuth signature or credentials' : error.message,
        details: error.response?.data || error.message
      };
    }
  }
}

/**
 * Authentication Manager
 * Handles authentication method selection and validation
 * Prioritizes Basic Auth as recommended for Gravity Forms v2
 */
export class AuthManager {
  constructor(config) {
    this.config = config;
    this.authHandler = null;

    this.validateConfig();
    this.initializeAuthHandler();
  }

  /**
   * Validate authentication configuration
   */
  validateConfig() {
    const required = ['GRAVITY_FORMS_CONSUMER_KEY', 'GRAVITY_FORMS_CONSUMER_SECRET', 'GRAVITY_FORMS_BASE_URL'];
    const missing = required.filter(key => !this.config[key]);

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Validate base URL format
    const baseUrl = this.config.GRAVITY_FORMS_BASE_URL;
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      throw new Error('GRAVITY_FORMS_BASE_URL must start with http:// or https://');
    }

    // Remove trailing slash
    this.config.GRAVITY_FORMS_BASE_URL = baseUrl.replace(/\/$/, '');
  }

  /**
   * Initialize authentication handler
   * Prioritizes Basic Authentication as primary method
   */
  initializeAuthHandler() {
    const { GRAVITY_FORMS_CONSUMER_KEY, GRAVITY_FORMS_CONSUMER_SECRET, GRAVITY_FORMS_BASE_URL } = this.config;

    // Default to Basic Authentication (RECOMMENDED for Gravity Forms v2)
    const authMethod = this.config.GRAVITY_FORMS_AUTH_METHOD || 'basic';

    try {
      if (authMethod.toLowerCase() === 'oauth' || authMethod.toLowerCase() === 'oauth1') {
        if (this.config.GRAVITY_FORMS_DEBUG === 'true') {
          logger.info('🔐 Using OAuth 1.0a Authentication');
        }
        this.authHandler = new OAuth1Handler(
          GRAVITY_FORMS_CONSUMER_KEY,
          GRAVITY_FORMS_CONSUMER_SECRET,
          GRAVITY_FORMS_BASE_URL
        );
      } else {
        if (this.config.GRAVITY_FORMS_DEBUG === 'true') {
          logger.info('🔐 Using Basic Authentication (Recommended for Gravity Forms v2)');
        }
        this.authHandler = new BasicAuthHandler(
          GRAVITY_FORMS_CONSUMER_KEY,
          GRAVITY_FORMS_CONSUMER_SECRET,
          GRAVITY_FORMS_BASE_URL
        );
      }
    } catch (error) {
      // Fallback to OAuth if Basic Auth fails (e.g., HTTP instead of HTTPS)
      if (authMethod.toLowerCase() === 'basic' && error.message.includes('HTTPS')) {
        // Only warn if not in test mode - check multiple ways tests might be run
        const isTest = process.env.NODE_ENV === 'test' ||
                      process.env.GRAVITY_FORMS_TEST_MODE === 'true' ||
                      process.argv.some(arg => arg.includes('test'));
        if (!isTest) {
          logger.warn('⚠️  Basic Authentication requires HTTPS. Falling back to OAuth 1.0a');
        }
        this.authHandler = new OAuth1Handler(
          GRAVITY_FORMS_CONSUMER_KEY,
          GRAVITY_FORMS_CONSUMER_SECRET,
          GRAVITY_FORMS_BASE_URL
        );
      } else {
        throw error;
      }
    }
  }

  /**
   * Get authentication headers for HTTP requests
   */
  getAuthHeaders(method = 'GET', url, params = {}) {
    return this.authHandler.getAuthHeaders(method, url, params);
  }

  /**
   * Test authentication connection
   */
  async testConnection(httpClient) {
    return await this.authHandler.testConnection(httpClient);
  }

  /**
   * Get authentication method info
   */
  getAuthInfo() {
    return {
      method: this.authHandler instanceof BasicAuthHandler ? 'Basic Authentication' : 'OAuth 1.0a',
      baseUrl: this.config.GRAVITY_FORMS_BASE_URL,
      secure: this.config.GRAVITY_FORMS_BASE_URL.startsWith('https://'),
      recommended: this.authHandler instanceof BasicAuthHandler
    };
  }
}

/**
 * Validate REST API availability and capabilities
 * Ensures Gravity Forms REST API v2 is properly configured
 */
export async function validateRestApiAccess(httpClient, authManager) {
  try {
    // Test basic connectivity
    const connectionResult = await authManager.testConnection(httpClient);
    if (!connectionResult.success) {
      return {
        available: false,
        error: 'Authentication failed',
        details: connectionResult
      };
    }

    // Test specific endpoints to verify full API access
    const endpoints = [
      { path: '/forms', name: 'Forms' },
      { path: '/entries', name: 'Entries' },
      { path: '/feeds', name: 'Feeds' }
    ];

    // Get baseURL from httpClient for OAuth signature generation
    const baseURL = httpClient?.defaults?.baseURL;

    if (!baseURL) {
      throw new Error('httpClient baseURL is not configured');
    }

    const results = [];
    for (const endpoint of endpoints) {
      try {
        // Generate proper OAuth headers with full URL for signature
        const fullUrl = `${baseURL}${endpoint.path}`;
        const headers = authManager.getAuthHeaders('GET', fullUrl, { per_page: 1 });
        await httpClient.get(endpoint.path, {
          headers,
          params: { per_page: 1 }
        });
        results.push({ ...endpoint, available: true });
      } catch (error) {
        results.push({
          ...endpoint,
          available: false,
          error: error.response?.status || 'Unknown error'
        });
      }
    }

    const availableEndpoints = results.filter(r => r.available).length;
    const totalEndpoints = results.length;

    return {
      available: availableEndpoints > 0,
      authMethod: authManager.getAuthInfo().method,
      endpoints: results,
      coverage: `${availableEndpoints}/${totalEndpoints}`,
      fullAccess: availableEndpoints === totalEndpoints,
      message: availableEndpoints === totalEndpoints
        ? 'Full REST API access confirmed'
        : `Partial access: ${availableEndpoints}/${totalEndpoints} endpoints available`
    };

  } catch (error) {
    return {
      available: false,
      error: 'REST API validation failed',
      details: error.message
    };
  }
}

export default AuthManager;