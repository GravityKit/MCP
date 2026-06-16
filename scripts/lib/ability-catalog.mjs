/**
 * Helpers for reading the WordPress Abilities catalog (dev tooling).
 */

/**
 * Collect every ability name with the given prefix from the WP Abilities
 * endpoint. Defaults to the `gk-` GravityKit prefix so it covers every
 * product namespace (gk-gravityview, gk-multiple-forms, …), not just
 * GravityView. The endpoint paginates (default per_page 50), so all pages
 * must be walked or names beyond the first page are missed.
 *
 * @param {object} wpClient - WordPressClient (has baseUrl + httpClient.request)
 * @param {{prefix?: string, perPage?: number}} [opts]
 * @returns {Promise<Set<string>>}
 */
export async function collectAbilityNames(wpClient, { prefix = 'gk-', perPage = 100 } = {}) {
  const names = new Set();
  for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
    const resp = await wpClient.httpClient.request({
      method: 'GET',
      baseURL: wpClient.baseUrl,
      url: '/wp-json/wp-abilities/v1/abilities',
      params: { per_page: perPage, page },
    });
    for (const a of resp.data) {
      if (a.name?.startsWith(prefix)) names.add(a.name);
    }
    totalPages = Number(resp.headers?.['x-wp-totalpages']) || 1;
  }
  return names;
}
