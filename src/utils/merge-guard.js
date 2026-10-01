/**
 * Merge guard for gf_update_form and gf_update_feed.
 *
 * Both tools fetch the stored resource and spread the caller's keys over it, which
 * is shallow: a key the caller does not mention survives, but a nested object the
 * caller DOES send replaces the stored one whole. Gravity Forms has no merge
 * either (GFAPI::update_form re-keys confirmations/notifications by id and writes
 * each column whole; a feed's meta is written whole), so a caller who sends one
 * confirmation gets one confirmation, and a webhook feed that sends a new name
 * loses its URL while it stays active.
 *
 * The guard refuses such a call before anything is written. Deep-merging instead
 * would hide the opposite mistake: a caller who sends the full desired map to
 * remove the rest would silently keep them. Refusal has no silent path either way.
 */

const MAX_LISTED_PATHS = 40;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// null and '' are what the compact reader strips from gf_get_form and gf_get_feed,
// so a caller who read, edited and sent back is missing them without having
// removed anything. GF stores an omitted empty key as absent and reads both alike.
const isEmpty = (value) => value === null || value === '';

const hasId = (item) => isPlainObject(item) && item.id !== undefined && item.id !== null && item.id !== '';

/**
 * Paths of stored keys the sent value would drop.
 *
 * @param {*} stored Stored value.
 * @param {*} sent Value the caller sent for the same place.
 * @param {string} [path] Path of this place, for the report.
 * @returns {string[]} e.g. ['fields[3]', 'fields[7].conditionalLogic', 'meta.requestURL'].
 */
export function droppedPaths(stored, sent, path = '') {
  const dropped = [];

  if (isPlainObject(stored) && isPlainObject(sent)) {
    for (const key of Object.keys(stored)) {
      if (isEmpty(stored[key])) continue;

      const here = path ? `${path}.${key}` : key;
      if (sent[key] === undefined) {
        dropped.push(here);
      } else {
        dropped.push(...droppedPaths(stored[key], sent[key], here));
      }
    }
    return dropped;
  }

  const storedIsIdentified = Array.isArray(stored) && stored.length > 0 && stored.every(hasId);
  if (storedIsIdentified && Array.isArray(sent)) {
    // Matched by id, never by position: a reordered list drops nothing.
    const sentById = new Map(sent.filter(hasId).map((item) => [String(item.id), item]));
    for (const item of stored) {
      const here = `${path}[${item.id}]`;
      const counterpart = sentById.get(String(item.id));
      if (counterpart === undefined) {
        dropped.push(here);
      } else {
        dropped.push(...droppedPaths(item, counterpart, here));
      }
    }
  }

  // Anything else (scalars, arrays without ids such as choices) is replaced, which
  // is what sending one means.
  return dropped;
}

const ALTERNATIVES = {
  form: 'use gf_update_field to change one field or gf_delete_field to remove one',
  feed: 'use gf_patch_feed to change only the keys you send'
};

/**
 * Refuse an update that would drop stored keys from a property it sends, unless
 * `replace` names that property.
 *
 * @param {object} options
 * @param {string} options.tool Tool name, for the message.
 * @param {'form'|'feed'} options.noun What is being updated.
 * @param {object} options.stored The stored resource.
 * @param {object} options.updates The caller's keys (without `id` or `replace`).
 * @param {string[]} options.replace Properties the caller said to replace whole.
 * @returns {string[]} Paths removed on purpose (empty when none).
 * @throws When a property not named in `replace` would lose stored keys.
 */
export function guardMerge({ tool, noun, stored, updates, replace = [] }) {
  const unsent = replace.filter((name) => updates[name] === undefined);
  if (unsent.length > 0) {
    throw new Error(`replace names ${unsent.join(', ')}, which this call does not send. Remove it from replace, or send the property`);
  }

  const refused = [];
  const refusedNames = [];
  const removed = [];

  for (const key of Object.keys(updates)) {
    if (updates[key] === undefined || stored?.[key] === undefined) continue;

    const paths = droppedPaths(stored[key], updates[key], key);
    if (paths.length === 0) continue;

    if (replace.includes(key)) {
      removed.push(...paths);
    } else {
      refused.push(...paths);
      refusedNames.push(key);
    }
  }

  if (refused.length > 0) {
    const listed = refused.length > MAX_LISTED_PATHS
      ? `${refused.slice(0, MAX_LISTED_PATHS).join(', ')}, …and ${refused.length - MAX_LISTED_PATHS} more`
      : refused.join(', ');
    const replaceArg = `[${refusedNames.map((name) => `"${name}"`).join(', ')}]`;

    throw new Error(
      `${tool} replaces ${refusedNames.join(' and ')} whole, and what you sent would drop ${refused.length} stored key(s): ${listed}. ` +
      `The ${noun} was not changed. Send every key you want kept (copy from gf_get_${noun} and change what you need), ` +
      `set a key to null to clear it, ${ALTERNATIVES[noun]}, or pass replace: ${replaceArg} to remove these on purpose`
    );
  }

  return removed;
}
