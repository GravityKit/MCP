/**
 * Unit tests for field-registry utility functions.
 */

import test from 'node:test';
import assert from 'node:assert';
import { generateCompoundInputs, isCompoundField, getFieldDefinition, assignFieldIds, validateFieldConfig, detectFieldVariant } from '../src/field-definitions/field-registry.js';

test('assignFieldIds', async (t) => {
  await t.test('assigns sequential ids when none are provided', () => {
    const out = assignFieldIds([{ type: 'text' }, { type: 'email' }, { type: 'number' }]);
    assert.deepStrictEqual(out.map((f) => f.id), [1, 2, 3]);
  });

  await t.test('fills around explicit ids without collision', () => {
    const out = assignFieldIds([{ id: 5, type: 'text' }, { type: 'email' }, { id: 2, type: 'text' }, { type: 'number' }]);
    assert.strictEqual(out[0].id, 5);
    assert.strictEqual(out[2].id, 2);
    assert.deepStrictEqual([out[1].id, out[3].id], [6, 7]); // max(5,2)+1, +1
    const ids = out.map((f) => f.id);
    assert.strictEqual(new Set(ids).size, ids.length); // all unique
  });

  await t.test('leaves already-numbered fields untouched', () => {
    const out = assignFieldIds([{ id: 1, type: 'text' }, { id: 2, type: 'email' }]);
    assert.deepStrictEqual(out.map((f) => f.id), [1, 2]);
  });

  await t.test('re-bases compound sub-input ids to the assigned field id', () => {
    const out = assignFieldIds([
      { id: 9, type: 'text' },
      { type: 'name', inputs: [{ id: '2.3', label: 'First' }, { id: '2.6', label: 'Last' }] },
    ]);
    assert.strictEqual(out[1].id, 10);
    assert.deepStrictEqual(out[1].inputs.map((i) => i.id), ['10.3', '10.6']);
  });

  await t.test('tolerates non-array input', () => {
    assert.strictEqual(assignFieldIds(undefined), undefined);
  });
});

test('generateCompoundInputs - address field', async (t) => {
  await t.test('generates US address inputs', () => {
    const field = { id: 5, type: 'address', addressType: 'us' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 6);
    assert.strictEqual(inputs[0].id, '5.1');
    assert.strictEqual(inputs[0].label, 'Street Address');
    assert.strictEqual(inputs[3].label, 'State');
    assert.strictEqual(inputs[4].label, 'ZIP Code');
  });

  await t.test('generates international address inputs', () => {
    const field = { id: 10, type: 'address', addressType: 'international' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 6);
    assert.strictEqual(inputs[3].label, 'State / Province');
    assert.strictEqual(inputs[4].label, 'ZIP / Postal Code');
  });

  await t.test('generates Canadian address inputs', () => {
    const field = { id: 3, type: 'address', addressType: 'canadian' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 6);
    assert.strictEqual(inputs[3].label, 'Province');
    assert.strictEqual(inputs[4].label, 'Postal Code');
  });

  await t.test('defaults to US format when addressType missing', () => {
    const field = { id: 1, type: 'address' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs[3].label, 'State');
    assert.strictEqual(inputs[4].label, 'ZIP Code');
  });
});

test('generateCompoundInputs - name field', async (t) => {
  await t.test('generates advanced name inputs', () => {
    const field = { id: 7, type: 'name', nameFormat: 'advanced' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 5);
    assert.strictEqual(inputs[0].id, '7.2');
    assert.strictEqual(inputs[0].label, 'Prefix');
    assert.strictEqual(inputs[1].id, '7.3');
    assert.strictEqual(inputs[1].label, 'First');
    assert.strictEqual(inputs[3].id, '7.6');
    assert.strictEqual(inputs[3].label, 'Last');
  });

  await t.test('generates simple name inputs', () => {
    const field = { id: 2, type: 'name', nameFormat: 'simple' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 2);
    assert.strictEqual(inputs[0].id, '2.3');
    assert.strictEqual(inputs[0].label, 'First');
    assert.strictEqual(inputs[1].id, '2.6');
    assert.strictEqual(inputs[1].label, 'Last');
  });

  await t.test('defaults to advanced format when nameFormat missing', () => {
    const field = { id: 1, type: 'name' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 5);
  });
});

test('generateCompoundInputs - creditcard field', async (t) => {
  await t.test('generates creditcard inputs', () => {
    const field = { id: 9, type: 'creditcard' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 5);
    assert.strictEqual(inputs[0].id, '9.1');
    assert.strictEqual(inputs[0].label, 'Card Number');
    assert.strictEqual(inputs[1].label, 'Expiration Date');
    assert.strictEqual(inputs[2].label, 'Security Code');
    assert.strictEqual(inputs[3].label, 'Card Type');
    assert.strictEqual(inputs[4].label, 'Cardholder Name');
  });
});

test('generateCompoundInputs - consent field', async (t) => {
  await t.test('generates consent inputs', () => {
    const field = { id: 4, type: 'consent' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs.length, 3);
    assert.strictEqual(inputs[0].id, '4.1');
    assert.strictEqual(inputs[0].label, 'Consent');
    assert.strictEqual(inputs[1].id, '4.2');
    assert.strictEqual(inputs[2].id, '4.3');
  });
});

test('generateCompoundInputs - non-compound fields', async (t) => {
  await t.test('returns null for text field', () => {
    const field = { id: 1, type: 'text' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs, null);
  });

  await t.test('returns null for email field', () => {
    const field = { id: 1, type: 'email' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs, null);
  });

  await t.test('returns null for unknown field type', () => {
    const field = { id: 1, type: 'nonexistent' };
    const inputs = generateCompoundInputs(field);

    assert.strictEqual(inputs, null);
  });
});

test('validateFieldConfig', async (t) => {
  // Unknown / third-party types are tolerated, not rejected: consistent with
  // FieldManager.addField and the form-create validator. There is no config
  // schema for a type we don't know, so there is nothing to reject.
  await t.test('tolerates an unknown field type', () => {
    const result = validateFieldConfig({ id: 7, type: 'mailpot_custom', label: 'Custom' });
    assert.strictEqual(result.isValid, true);
  });

  await t.test('still rejects a known type missing required config (choice field without choices)', () => {
    const result = validateFieldConfig({ id: 7, type: 'select', label: 'Pick' });
    assert.strictEqual(result.isValid, false);
    assert.match(result.error, /choices/i);
  });

  await t.test('accepts a well-formed known field', () => {
    const result = validateFieldConfig({ id: 7, type: 'text', label: 'Name' });
    assert.strictEqual(result.isValid, true);
  });
});

test('assignFieldIds reassigns duplicate explicit ids so none collide', () => {
  const out = assignFieldIds([{ id: 5, type: 't' }, { id: 5, type: 'e' }]);
  const ids = out.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate field ids');
  assert.strictEqual(out[0].id, 5, 'first explicit id is preserved');
});

test('field-registry null-input guards (no TypeError on hostile input)', async (t) => {
  await t.test('validateFieldConfig(null) → {isValid:false}, no throw', () => {
    assert.strictEqual(validateFieldConfig(null).isValid, false);
  });
  await t.test('detectFieldVariant(null) → "default", no throw', () => {
    assert.strictEqual(detectFieldVariant(null), 'default');
  });
  await t.test('generateCompoundInputs(null) → null, no throw', () => {
    assert.strictEqual(generateCompoundInputs(null), null);
  });
});

test('isCompoundField', async (t) => {
  await t.test('returns true for address', () => {
    assert.strictEqual(isCompoundField('address'), true);
  });

  await t.test('returns true for name', () => {
    assert.strictEqual(isCompoundField('name'), true);
  });

  await t.test('returns false for text', () => {
    assert.strictEqual(isCompoundField('text'), false);
  });

  await t.test('returns false for unknown type', () => {
    assert.strictEqual(isCompoundField('nonexistent'), false);
  });

  await t.test('returns true for checkbox (compound dot-notation)', () => {
    assert.strictEqual(isCompoundField('checkbox'), true);
  });

  await t.test('returns true for chainedselect (compound dot-notation)', () => {
    assert.strictEqual(isCompoundField('chainedselect'), true);
  });

  await t.test('returns true for consent', () => {
    assert.strictEqual(isCompoundField('consent'), true);
  });
});

test('storage definitions match GFAPI-verified patterns', async (t) => {
  await t.test('checkbox: compound dotNotation with choices', () => {
    const def = getFieldDefinition('checkbox');
    assert.strictEqual(def.storage.type, 'compound');
    assert.strictEqual(def.storage.format, 'dotNotation');
    assert.strictEqual(def.hasChoices, true);
    assert.strictEqual(def.isCompound, true);
    assert.strictEqual(def.isArray, true);
  });

  await t.test('multiselect: string commaSeparated', () => {
    const def = getFieldDefinition('multiselect');
    assert.strictEqual(def.storage.type, 'string');
    assert.strictEqual(def.storage.format, 'commaSeparated');
    assert.strictEqual(def.hasChoices, true);
    assert.strictEqual(def.isMultiValue, true);
    assert.strictEqual(def.isArray, true);
  });

  await t.test('select: string single', () => {
    const def = getFieldDefinition('select');
    assert.strictEqual(def.storage.type, 'string');
    assert.strictEqual(def.storage.format, 'single');
    assert.strictEqual(def.hasChoices, true);
  });

  await t.test('radio: string single', () => {
    const def = getFieldDefinition('radio');
    assert.strictEqual(def.storage.type, 'string');
    assert.strictEqual(def.storage.format, 'single');
    assert.strictEqual(def.hasChoices, true);
  });

  await t.test('consent: 3 sub-inputs (checked, text, revision)', () => {
    const def = getFieldDefinition('consent');
    assert.strictEqual(def.storage.subInputs['1'], 'checked');
    assert.strictEqual(def.storage.subInputs['2'], 'text');
    assert.strictEqual(def.storage.subInputs['3'], 'revision');
  });

  await t.test('chainedselect: compound dotNotation', () => {
    const def = getFieldDefinition('chainedselect');
    assert.strictEqual(def.storage.type, 'compound');
    assert.strictEqual(def.storage.format, 'dotNotation');
    assert.strictEqual(def.isCompound, true);
    assert.strictEqual(def.isChained, true);
  });

  await t.test('list: array serialized', () => {
    const def = getFieldDefinition('list');
    assert.strictEqual(def.storage.type, 'array');
    assert.strictEqual(def.storage.format, 'serialized');
    assert.strictEqual(def.isArray, true);
  });
});

test('variant-specific storage definitions', async (t) => {
  await t.test('post_category variants have storage overrides', () => {
    const def = getFieldDefinition('post_category');
    assert.strictEqual(def.variants.checkboxes.storage.type, 'compound');
    assert.strictEqual(def.variants.checkboxes.storage.format, 'dotNotation');
    assert.strictEqual(def.variants.multiselect.storage.type, 'string');
    assert.strictEqual(def.variants.multiselect.storage.format, 'commaSeparated');
    assert.strictEqual(def.variants.dropdown.storage.type, 'string');
    assert.strictEqual(def.variants.dropdown.storage.format, 'single');
  });

  await t.test('post_custom_field has checkbox and multiselect variants', () => {
    const def = getFieldDefinition('post_custom_field');
    assert.strictEqual(def.variants.checkbox.storage.type, 'compound');
    assert.strictEqual(def.variants.checkbox.storage.format, 'dotNotation');
    assert.strictEqual(def.variants.multiselect.storage.type, 'string');
    assert.strictEqual(def.variants.multiselect.storage.format, 'commaSeparated');
  });

  await t.test('product has variant-specific storage', () => {
    const def = getFieldDefinition('product');
    assert.strictEqual(def.variants.checkbox.storage.type, 'compound');
    assert.strictEqual(def.variants.singleproduct.storage.type, 'compound');
    assert.strictEqual(def.variants.dropdown.storage.type, 'string');
    assert.strictEqual(def.variants.radio.storage.type, 'string');
  });

  await t.test('option has variant-specific storage', () => {
    const def = getFieldDefinition('option');
    assert.strictEqual(def.variants.checkboxes.storage.type, 'compound');
    assert.strictEqual(def.variants.dropdown.storage.type, 'string');
    assert.strictEqual(def.variants.radio.storage.type, 'string');
  });

  await t.test('quiz has variant-specific storage', () => {
    const def = getFieldDefinition('quiz');
    assert.strictEqual(def.variants.checkbox.storage.type, 'compound');
    assert.strictEqual(def.variants.dropdown.storage.type, 'string');
    assert.strictEqual(def.variants.radio.storage.type, 'string');
  });

  await t.test('poll has variant-specific storage', () => {
    const def = getFieldDefinition('poll');
    assert.strictEqual(def.variants.checkbox.storage.type, 'compound');
    assert.strictEqual(def.variants.dropdown.storage.type, 'string');
    assert.strictEqual(def.variants.radio.storage.type, 'string');
  });
});

test('survey field type exists with all variants', async (t) => {
  await t.test('survey type is in registry', () => {
    const def = getFieldDefinition('survey');
    assert.ok(def, 'survey should exist in registry');
    assert.strictEqual(def.type, 'survey');
    assert.strictEqual(def.category, 'survey');
    // hasChoices moved to variant level (text/textarea variants don't have choices)
    assert.strictEqual(def.hasChoices, undefined);
  });

  await t.test('survey has all inputType variants', () => {
    const def = getFieldDefinition('survey');
    const variantNames = Object.keys(def.variants);
    assert.ok(variantNames.includes('radio'), 'should have radio');
    assert.ok(variantNames.includes('checkbox'), 'should have checkbox');
    assert.ok(variantNames.includes('select'), 'should have select');
    assert.ok(variantNames.includes('likert'), 'should have likert');
    assert.ok(variantNames.includes('rank'), 'should have rank');
    assert.ok(variantNames.includes('rating'), 'should have rating');
    assert.ok(variantNames.includes('text'), 'should have text');
    assert.ok(variantNames.includes('textarea'), 'should have textarea');
  });

  await t.test('survey checkbox variant uses dotNotation', () => {
    const def = getFieldDefinition('survey');
    assert.strictEqual(def.variants.checkbox.storage.type, 'compound');
    assert.strictEqual(def.variants.checkbox.storage.format, 'dotNotation');
  });

  await t.test('survey radio/select variants use single value', () => {
    const def = getFieldDefinition('survey');
    assert.strictEqual(def.variants.radio.storage.type, 'string');
    assert.strictEqual(def.variants.select.storage.type, 'string');
  });

  await t.test('survey choice-based variants have hasChoices, text/textarea do not', () => {
    const def = getFieldDefinition('survey');
    assert.strictEqual(def.variants.radio.hasChoices, true);
    assert.strictEqual(def.variants.checkbox.hasChoices, true);
    assert.strictEqual(def.variants.select.hasChoices, true);
    assert.strictEqual(def.variants.likert.hasChoices, true);
    assert.strictEqual(def.variants.text.hasChoices, undefined);
    assert.strictEqual(def.variants.textarea.hasChoices, undefined);
  });

  await t.test('legacy survey_likert/rank/rating still in registry', () => {
    assert.ok(getFieldDefinition('survey_likert'));
    assert.ok(getFieldDefinition('survey_rank'));
    assert.ok(getFieldDefinition('survey_rating'));
  });
});
