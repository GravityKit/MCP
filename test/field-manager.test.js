/**
 * Unit tests for FieldManager class
 * Tests field CRUD operations with mocked API client
 */

import test from 'node:test';
import assert from 'node:assert';
import { FieldManager } from '../src/field-operations/field-manager.js';
import FieldAwareValidator from '../src/config/field-validation.js';

// Mock dependencies. Mirrors the GravityFormsClient contract FieldManager
// actually consumes: getForm() resolves { form } and replaceForm() does a
// direct PUT resolving { form } (see field-manager.js).
const createMockApiClient = () => ({
  getForm: async () => ({
    form: {
      id: 1,
      title: 'Test Form',
      fields: [
        { id: 1, type: 'text', label: 'Name' },
        { id: 2, type: 'email', label: 'Email' },
        { id: 3, type: 'textarea', label: 'Message' }
      ]
    }
  }),
  replaceForm: async (formId, form) => ({ form })
});

const createMockRegistry = () => ({
  text: {
    label: 'Single Line Text',
    category: 'standard',
    defaults: { size: 'medium' }
  },
  email: {
    label: 'Email',
    category: 'advanced',
    defaults: { size: 'medium' }
  },
  address: {
    label: 'Address',
    category: 'advanced',
    storage: { type: 'compound' },
    hasChoices: false
  },
  select: {
    label: 'Dropdown',
    category: 'standard',
    hasChoices: true
  },
  date: {
    label: 'Date',
    category: 'advanced'
  }
});

const createMockValidator = () => ({
  getWarnings: () => []
});

test('FieldManager - generateFieldId', async (t) => {
  const apiClient = createMockApiClient();
  const registry = createMockRegistry();
  const validator = createMockValidator();
  const manager = new FieldManager(apiClient, registry, validator);

  await t.test('generates next ID for existing fields', () => {
    const fields = [
      { id: 1 },
      { id: 3 },
      { id: 5 }
    ];
    const newId = manager.generateFieldId(fields);
    assert.strictEqual(newId, 6);
  });

  await t.test('generates ID 1 for empty fields array', () => {
    const newId = manager.generateFieldId([]);
    assert.strictEqual(newId, 1);
  });

  await t.test('handles non-numeric IDs', () => {
    const fields = [
      { id: 'abc' },
      { id: 2 },
      { id: '3' }
    ];
    const newId = manager.generateFieldId(fields);
    assert.strictEqual(newId, 4);
  });
});

test('FieldManager - createField', async (t) => {
  const apiClient = createMockApiClient();
  const registry = createMockRegistry();
  const validator = createMockValidator();
  const manager = new FieldManager(apiClient, registry, validator);

  await t.test('creates field with defaults', () => {
    const field = manager.createField(5, 'text', {}, registry.text);
    assert.strictEqual(field.id, 5);
    assert.strictEqual(field.type, 'text');
    assert.strictEqual(field.label, 'Single Line Text');
    assert.strictEqual(field.size, 'medium');
    assert.strictEqual(field.isRequired, false);
  });

  await t.test('creates field with custom properties', () => {
    const field = manager.createField(
      5, 
      'email', 
      { label: 'Work Email', isRequired: true },
      registry.email
    );
    assert.strictEqual(field.label, 'Work Email');
    assert.strictEqual(field.isRequired, true);
  });

  await t.test('creates choice field with default choices', () => {
    const field = manager.createField(5, 'select', {}, registry.select);
    assert.ok(Array.isArray(field.choices));
    assert.strictEqual(field.choices.length, 3);
    assert.strictEqual(field.choices[0].text, 'First Choice');
  });

  await t.test('creates date field with format defaults', () => {
    const field = manager.createField(5, 'date', {}, registry.date);
    assert.strictEqual(field.dateFormat, 'mdy');
    assert.strictEqual(field.dateType, 'datepicker');
  });
});

test('FieldManager - generateSubInputs', async (t) => {
  const apiClient = createMockApiClient();
  const registry = createMockRegistry();
  const validator = createMockValidator();
  const manager = new FieldManager(apiClient, registry, validator);

  await t.test('generates address field sub-inputs', () => {
    const field = { id: 10, type: 'address', addressType: 'us' };
    const subInputs = manager.generateSubInputs(field, registry.address);
    
    assert.strictEqual(subInputs.length, 6);
    assert.strictEqual(subInputs[0].id, '10.1');
    assert.strictEqual(subInputs[0].label, 'Street Address');
    assert.strictEqual(subInputs[4].label, 'ZIP Code');
  });

  await t.test('generates international address sub-inputs', () => {
    const field = { id: 10, type: 'address', addressType: 'international' };
    const subInputs = manager.generateSubInputs(field, registry.address);
    
    assert.strictEqual(subInputs[4].label, 'ZIP / Postal Code');
    assert.strictEqual(subInputs[3].label, 'State / Province');
  });

  await t.test('generates name field sub-inputs', () => {
    const field = { id: 15, type: 'name', nameFormat: 'advanced' };
    const fieldDef = { storage: { type: 'compound' } };
    const subInputs = manager.generateSubInputs(field, fieldDef);

    assert.strictEqual(subInputs.length, 5);
    assert.strictEqual(subInputs[0].id, '15.2'); // Prefix
    assert.strictEqual(subInputs[1].id, '15.3'); // First
    assert.strictEqual(subInputs[1].label, 'First');
  });

  // Chained Selects: one sub-input per dropdown level. Validated against the
  // GF Chained Selects add-on (class-gf-field-chainedselect.php): inputs are
  // fieldId.N, counting 1,2,…,9,11,12,… and SKIPPING multiples of 10, labelled
  // per column; a fresh field defaults to two levels (Parents/Children).
  await t.test('generates chainedselect sub-inputs, one per configured level', () => {
    const field = { id: 5, type: 'chainedselect', inputs: [{ label: 'Make' }, { label: 'Model' }, { label: 'Trim' }] };
    const fieldDef = { storage: { type: 'compound' } };
    const subInputs = manager.generateSubInputs(field, fieldDef);

    assert.strictEqual(subInputs.length, 3);
    assert.deepStrictEqual(subInputs.map((i) => i.id), ['5.1', '5.2', '5.3']);
    assert.deepStrictEqual(subInputs.map((i) => i.label), ['Make', 'Model', 'Trim']);
  });

  await t.test('chainedselect defaults to two levels when none are configured', () => {
    const field = { id: 2, type: 'chainedselect' };
    const fieldDef = { storage: { type: 'compound' } };
    const subInputs = manager.generateSubInputs(field, fieldDef);

    assert.deepStrictEqual(subInputs.map((i) => i.id), ['2.1', '2.2']);
    assert.deepStrictEqual(subInputs.map((i) => i.label), ['Parents', 'Children']);
  });

  await t.test('chainedselect skips the reserved .10 sub-input id', () => {
    const field = { id: 1, type: 'chainedselect', inputs: Array.from({ length: 10 }, (_, i) => ({ label: `L${i + 1}` })) };
    const fieldDef = { storage: { type: 'compound' } };
    const subInputs = manager.generateSubInputs(field, fieldDef);

    const ids = subInputs.map((i) => i.id);
    assert.ok(!ids.includes('1.10'), 'must skip the reserved .10 slot');
    assert.deepStrictEqual(ids, ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.11']);
  });
});

test('FieldManager - addField', async (t) => {
  await t.test('adds field to form successfully', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    // Mock position engine
    manager.positionEngine = {
      calculatePosition: () => 3
    };

    const result = await manager.addField(
      1,
      'text',
      { label: 'New Field' },
      { mode: 'append' }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.field.type, 'text');
    assert.strictEqual(result.field.label, 'New Field');
    assert.strictEqual(result.field.id, 4); // Next ID after 1,2,3
    assert.strictEqual(result.position.index, 3);
  });

  await t.test('rejects unknown field type', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);

    await assert.rejects(
      async () => await manager.addField(1, 'unknown_type', {}),
      /Unknown field type: unknown_type/
    );
  });
});

test('FieldManager - updateField', async (t) => {
  await t.test('updates field successfully', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    // Mock dependency tracker
    manager.dependencyTracker = {
      scanFormDependencies: () => ({ conditionalLogic: [] })
    };

    const result = await manager.updateField(
      1,
      2,
      { label: 'Updated Email', isRequired: true }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.field.label, 'Updated Email');
    assert.strictEqual(result.field.isRequired, true);
    assert.strictEqual(result.field.id, 2); // ID preserved
  });

  await t.test('warns about dependencies', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    // Mock dependency tracker with dependencies
    manager.dependencyTracker = {
      scanFormDependencies: () => ({
        conditionalLogic: [{ field_id: 1, field_label: 'Name' }]
      })
    };

    const result = await manager.updateField(1, 2, { label: 'Updated' });
    
    assert.strictEqual(result.success, true);
    assert.ok(result.warnings.dependencies.length > 0);
  });

  await t.test('throws for non-existent field', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);

    await assert.rejects(
      async () => await manager.updateField(1, 999, { label: 'Test' }),
      /Field 999 not found/
    );
  });
});

test('FieldManager - deleteField', async (t) => {
  await t.test('deletes field without dependencies', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    manager.dependencyTracker = {
      scanFormDependencies: () => ({ conditionalLogic: [] }),
      hasBreakingDependencies: () => false
    };

    const result = await manager.deleteField(1, 2);
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deleted_field.id, 2);
    assert.strictEqual(result.deleted_field.type, 'email');
  });

  await t.test('blocks deletion with dependencies when not forced', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    manager.dependencyTracker = {
      scanFormDependencies: () => ({
        conditionalLogic: [{ field_id: 1 }]
      }),
      hasBreakingDependencies: () => true
    };

    const result = await manager.deleteField(1, 2, { force: false });
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('dependencies'));
    assert.ok(result.suggestion.includes('force=true'));
  });

  await t.test('allows forced deletion with dependencies', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    manager.dependencyTracker = {
      scanFormDependencies: () => ({
        conditionalLogic: [{ field_id: 1 }]
      }),
      hasBreakingDependencies: () => true
    };

    const result = await manager.deleteField(1, 2, { force: true });
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deleted_field.id, 2);
  });

  await t.test('cleans up dependencies with cascade', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);
    
    let cleanupCalled = false;
    manager.dependencyTracker = {
      scanFormDependencies: () => ({
        conditionalLogic: [{ field_id: 1 }]
      }),
      hasBreakingDependencies: () => true
    };
    
    // Override cleanupDependencies to track if called
    manager.cleanupDependencies = () => { cleanupCalled = true; };

    const result = await manager.deleteField(1, 2, { cascade: true, force: true });
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(cleanupCalled, true);
    assert.ok(result.actions_taken.includes('Dependencies cleaned up'));
  });
});
test('FieldManager - normalizeLayoutProperties', async (t) => {
  const manager = new FieldManager(createMockApiClient(), createMockRegistry(), createMockValidator());

  await t.test('valid 8-char hex layoutGroupId passes through unchanged', () => {
    const field = { layoutGroupId: 'a1b2c3d4' };
    manager.normalizeLayoutProperties(field, 7);
    assert.strictEqual(field.layoutGroupId, 'a1b2c3d4');
  });

  await t.test('friendly layoutGroupId hashes to stable 8-char hex per form', () => {
    const first = manager.normalizeLayoutProperties({ layoutGroupId: 'name-row' }, 7);
    const second = manager.normalizeLayoutProperties({ layoutGroupId: 'name-row' }, 7);
    assert.match(first.layoutGroupId, /^[0-9a-f]{8}$/);
    assert.strictEqual(first.layoutGroupId, second.layoutGroupId, 'same name + form must share a row');
    const otherForm = manager.normalizeLayoutProperties({ layoutGroupId: 'name-row' }, 8);
    assert.notStrictEqual(first.layoutGroupId, otherForm.layoutGroupId, 'different forms must not collide');
  });

  await t.test('layoutGridColumnSpan clamps to the 1-12 editor grid', () => {
    assert.strictEqual(manager.normalizeLayoutProperties({ layoutGridColumnSpan: 20 }, 1).layoutGridColumnSpan, 12);
    assert.strictEqual(manager.normalizeLayoutProperties({ layoutGridColumnSpan: 0 }, 1).layoutGridColumnSpan, 1);
    assert.strictEqual(manager.normalizeLayoutProperties({ layoutGridColumnSpan: '6' }, 1).layoutGridColumnSpan, 6);
  });

  await t.test('non-numeric layoutGridColumnSpan is dropped for the editor to assign', () => {
    const field = manager.normalizeLayoutProperties({ layoutGridColumnSpan: 'wide' }, 1);
    assert.strictEqual('layoutGridColumnSpan' in field, false);
  });

  await t.test('layoutGridColumnSpan drops floats and partial-numeric strings', () => {
    const dropped = (value) => 'layoutGridColumnSpan' in manager.normalizeLayoutProperties({ layoutGridColumnSpan: value }, 1) === false;
    assert.ok(dropped('6wide'), '"6wide" should be dropped, not coerced to 6');
    assert.ok(dropped('6.5'), '"6.5" should be dropped');
    assert.ok(dropped(6.5), '6.5 (float) should be dropped');
    assert.ok(dropped(''), 'empty string should be dropped');
    assert.ok(dropped('   '), 'whitespace-only string should be dropped');
    assert.ok(dropped(true), 'boolean should be dropped');
    // Valid integers (and integer strings) are still kept.
    assert.strictEqual(manager.normalizeLayoutProperties({ layoutGridColumnSpan: 8 }, 1).layoutGridColumnSpan, 8);
    assert.strictEqual(manager.normalizeLayoutProperties({ layoutGridColumnSpan: ' 7 ' }, 1).layoutGridColumnSpan, 7);
  });

  await t.test('empty and missing layoutGroupId are left alone', () => {
    assert.strictEqual(manager.normalizeLayoutProperties({ layoutGroupId: '' }, 1).layoutGroupId, '');
    assert.strictEqual('layoutGroupId' in manager.normalizeLayoutProperties({}, 1), false);
  });
});

// Regression: production injects `new FieldAwareValidator()`, which has no
// getWarnings method — gf_add_field / gf_update_field threw
// "this.validator?.getWarnings is not a function" on every call. The existing
// suite missed it because its mock validator stubs getWarnings. These exercise
// the REAL validator the server wires up.
test('FieldManager - real FieldAwareValidator: add/update do not throw on getWarnings', async (t) => {
  const apiClient = createMockApiClient();
  const registry = createMockRegistry();
  const manager = new FieldManager(apiClient, registry, new FieldAwareValidator());

  await t.test('addField returns success and an array of warnings', async () => {
    const result = await manager.addField(1, 'text', { label: 'New Field' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.warnings));
  });

  await t.test('updateField returns success and array validationIssues', async () => {
    const result = await manager.updateField(1, 1, { label: 'Renamed' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.warnings.validationIssues));
  });
});

test('FieldAwareValidator.getWarnings', async (t) => {
  const v = new FieldAwareValidator();

  await t.test('returns [] for a well-formed field', () => {
    assert.deepStrictEqual(v.getWarnings({ id: 1, type: 'text', label: 'Name' }), []);
  });

  await t.test('warns when a field has no label', () => {
    assert.ok(v.getWarnings({ id: 5, type: 'text', label: '' }).some((m) => /label/i.test(m)));
  });

  await t.test('warns when a choice field has no choices', () => {
    assert.ok(v.getWarnings({ id: 6, type: 'select', label: 'Pick', choices: [] }).some((m) => /choice/i.test(m)));
  });

  await t.test('never throws on junk input', () => {
    assert.deepStrictEqual(v.getWarnings(null), []);
    assert.deepStrictEqual(v.getWarnings(undefined), []);
    assert.deepStrictEqual(v.getWarnings('nope'), []);
  });
});
