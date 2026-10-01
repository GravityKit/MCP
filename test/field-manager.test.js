/**
 * Unit tests for FieldManager class
 * Tests field CRUD operations with mocked API client
 */

import test from 'node:test';
import assert from 'node:assert';
import { FieldManager } from '../src/field-operations/field-manager.js';
import { PositionEngine } from '../src/field-operations/field-positioner.js';
import FieldAwareValidator from '../src/config/field-validation.js';
import { DependencyTracker } from '../src/field-operations/field-dependencies.js';

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
  replaceForm: async (formId, form) => ({ form }),
  // The real client sets this from GRAVITY_FORMS_ALLOW_DELETE; deletes read it.
  allowDelete: true
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
  multiselect: {
    label: 'Multi Select',
    category: 'choice',
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
      validatePositionConfig: () => ({ valid: true, errors: [], warnings: [] }),
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

  // Custom / third-party field types (Gravity Perks, add-ons, GravityKit, the
  // MailPot field a customer hit) are not in the static registry, yet Gravity
  // Forms accepts them on the form PUT. addField must not gate on the registry;
  // it degrades gracefully: create from caller properties, skip registry-derived
  // defaults/sub-inputs, and warn.
  await t.test('accepts an unknown field type instead of throwing', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);

    const result = await manager.addField(1, 'mailpot_custom', { label: 'Custom Field' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.field.type, 'mailpot_custom');
    assert.strictEqual(result.field.label, 'Custom Field');
    assert.strictEqual(result.field.id, 4); // Next ID after 1,2,3
  });

  await t.test('warns when the field type is not in the registry', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);

    const result = await manager.addField(1, 'mailpot_custom', { label: 'Custom Field' });

    assert.ok(Array.isArray(result.warnings));
    assert.ok(
      result.warnings.some((m) => /mailpot_custom/.test(m) && /registr/i.test(m)),
      'expected a warning naming the unrecognized field type'
    );
  });

  await t.test('rebases caller-supplied dotted sub-input ids onto the generated field id (unknown type)', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);

    // The caller guessed parent id 9, but the form's next id is 4. Sub-inputs
    // must follow the generated field id (4.x), not stay orphaned at 9.x. Labels
    // and other props are preserved.
    const result = await manager.addField(1, 'custom_compound', {
      label: 'Custom Compound',
      inputs: [{ id: '9.1', label: 'Part A' }, { id: '9.2', label: 'Part B' }]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.field.id, 4);
    assert.deepStrictEqual(result.field.inputs, [
      { id: '4.1', label: 'Part A' },
      { id: '4.2', label: 'Part B' }
    ]);
  });

  await t.test('known compound type still gets registry sub-inputs keyed on the generated field id', async () => {
    const apiClient = createMockApiClient();
    const registry = createMockRegistry();
    const validator = createMockValidator();
    const manager = new FieldManager(apiClient, registry, validator);

    const result = await manager.addField(1, 'address', { label: 'Mailing Address' });

    assert.strictEqual(result.field.id, 4);
    assert.deepStrictEqual(
      result.field.inputs.map((i) => i.id),
      ['4.1', '4.2', '4.3', '4.4', '4.5', '4.6']
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

  // Update gating contract: an update needs force only when it changes
  // properties dependents consume (type/choices/inputs) AND the field has
  // breaking dependents per the same hasBreakingDependencies set delete uses
  // (conditional logic + calculations + merge tags). Cosmetic changes always
  // proceed, with the dependency info still reported in warnings.

  const formWithDependents = () => ({
    id: 1,
    title: 'Deps Form',
    fields: [
      { id: 1, type: 'select', label: 'Color', choices: [{ text: 'Red', value: 'red' }] },
      {
        id: 2, type: 'text', label: 'Details',
        conditionalLogic: { enabled: true, rules: [{ fieldId: 1, operator: 'is', value: 'red' }] }
      },
      { id: 3, type: 'number', label: 'Total', enableCalculation: true, calculationFormula: '{Qty:4} * 2' },
      { id: 4, type: 'number', label: 'Qty' }
    ]
  });

  const managerWithDeps = (apiClient) => {
    const manager = new FieldManager(apiClient, createMockRegistry(), createMockValidator());
    manager.dependencyTracker = new DependencyTracker();
    return manager;
  };

  await t.test('cosmetic update (label) proceeds without force despite dependents', async () => {
    let saved = false;
    const apiClient = {
      getForm: async () => ({ form: formWithDependents() }),
      replaceForm: async (id, form) => { saved = true; return { form }; }
    };
    const result = await managerWithDeps(apiClient).updateField(1, 1, { label: 'Colour' }, { force: false });

    assert.strictEqual(result.success, true, 'a label change cannot break a {fieldId,operator,value} rule');
    assert.strictEqual(saved, true);
    assert.ok(result.warnings.dependencies.length > 0, 'dependency info still surfaces as a warning');
  });

  await t.test('does not persist a choices change without force when conditional logic depends on the field', async () => {
    let saved = false;
    const apiClient = {
      getForm: async () => ({ form: formWithDependents() }),
      replaceForm: async (id, form) => { saved = true; return { form }; }
    };
    const result = await managerWithDeps(apiClient).updateField(
      1, 1, { choices: [{ text: 'Green', value: 'green' }] }, { force: false }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(saved, false, 'must NOT persist the change when blocked');
    assert.match(result.suggestion || '', /force/);
  });

  await t.test('gates a type change on a field referenced in a CALCULATION (delete parity)', async () => {
    // The old gate checked only conditionalLogic, so rewriting a field a
    // calculation formula consumes sailed through un-warned while a label
    // tweak was blocked.
    let saved = false;
    const apiClient = {
      getForm: async () => ({ form: formWithDependents() }),
      replaceForm: async (id, form) => { saved = true; return { form }; }
    };
    const result = await managerWithDeps(apiClient).updateField(1, 4, { type: 'text' }, { force: false });

    assert.strictEqual(result.success, false);
    assert.strictEqual(saved, false);
  });

  await t.test('gates an inputType change, which moves the value without touching type', async () => {
    // survey/product/post_category keep `type` fixed and pick their storage shape with
    // `inputType`: radio -> checkbox turns one stored value into dot-notation
    // sub-inputs, so a dependent rule reads an address that no longer holds it.
    let saved = false;
    const apiClient = {
      getForm: async () => ({ form: formWithDependents() }),
      replaceForm: async (id, form) => { saved = true; return { form }; }
    };
    const result = await managerWithDeps(apiClient).updateField(1, 1, { inputType: 'checkbox' }, { force: false });

    assert.strictEqual(result.success, false);
    assert.strictEqual(saved, false, 'must NOT persist the change when blocked');
    assert.match(result.suggestion || '', /force/);
  });

  await t.test('breaking-prop change on a field nobody depends on proceeds without force', async () => {
    const apiClient = {
      getForm: async () => ({ form: formWithDependents() }),
      replaceForm: async (id, form) => ({ form })
    };
    const result = await managerWithDeps(apiClient).updateField(1, 2, { type: 'textarea' }, { force: false });

    assert.strictEqual(result.success, true);
  });

  await t.test('persists a gated change when force is true', async () => {
    let saved = false;
    const apiClient = {
      getForm: async () => ({ form: formWithDependents() }),
      replaceForm: async (id, form) => { saved = true; return { form }; }
    };
    const result = await managerWithDeps(apiClient).updateField(
      1, 1, { choices: [{ text: 'Green', value: 'green' }] }, { force: true }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(saved, true);
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

  // The cascade tests below use the REAL DependencyTracker and the real
  // cleanupDependencies. The old test stubbed cleanup out and passed force:true,
  // so it was green while cascade alone was refused.
  const cascadeForm = () => ({
    id: 164,
    title: 'Cascade',
    fields: [
      { id: 1, type: 'text', label: 'Trigger' },
      { id: 2, type: 'text', label: 'Shown', conditionalLogic: {
        enabled: true, actionType: 'show', logicType: 'all',
        rules: [{ fieldId: '1', operator: 'is', value: 'x' }]
      } },
      { id: 3, type: 'text', label: 'Keeps one', conditionalLogic: {
        enabled: true, actionType: 'show', logicType: 'all',
        rules: [{ fieldId: '1', operator: 'is', value: 'y' }, { fieldId: '2', operator: 'is', value: 'z' }]
      } },
      { id: 4, type: 'number', label: 'Price' },
      { id: 5, type: 'number', label: 'Double', enableCalculation: true, calculationFormula: '{Price:4} * 2' }
    ],
    confirmations: { c1: { id: 'c1', name: 'Default', type: 'message', message: 'Got {Trigger:1} and {Price:4}' } }
  });
  const cascadeManager = (form, saved) => {
    const api = {
      getForm: async () => ({ form }),
      replaceForm: async (id, f) => { saved.form = f; return { form: f }; },
      allowDelete: true
    };
    const manager = new FieldManager(api, createMockRegistry(), createMockValidator());
    manager.dependencyTracker = new DependencyTracker();
    return manager;
  };

  await t.test('cascade alone deletes the field and cleans conditional logic (no force needed)', async () => {
    const saved = {};
    const manager = cascadeManager(cascadeForm(), saved);

    const result = await manager.deleteField(164, 1, { cascade: true });

    assert.strictEqual(result.success, true, 'cascade=true must not be refused with advice to use cascade=true');
    assert.ok(!saved.form.fields.some((f) => f.id == 1), 'field 1 must be gone from the saved form');
    const field3 = saved.form.fields.find((f) => f.id == 3);
    assert.deepStrictEqual(field3.conditionalLogic.rules.map((r) => r.fieldId), ['2'], 'only the rule on the deleted field is removed');
    assert.ok(result.actions_taken.some((a) => /field 2/.test(a) && /Shown/.test(a)), 'actions_taken names the field it changed');
  });

  await t.test('cascade drops conditional logic that loses its last rule, in the shape GF reads as "no logic"', async () => {
    const saved = {};
    const manager = cascadeManager(cascadeForm(), saved);

    await manager.deleteField(164, 1, { cascade: true });

    const field2 = saved.form.fields.find((f) => f.id == 2);
    // GF's server-side get_field_display() ignores `enabled` and evaluates any
    // non-empty logic object: zero rules + actionType "hide" would hide the field
    // forever. Empty conditionalLogic is what GF itself treats as "no logic".
    assert.strictEqual(field2.conditionalLogic, '');
  });

  await t.test('cascade does not rewrite calculations or merge tags, and says they are left dangling', async () => {
    const saved = {};
    const manager = cascadeManager(cascadeForm(), saved);

    const result = await manager.deleteField(164, 4, { cascade: true });

    assert.strictEqual(result.success, true);
    const calc = saved.form.fields.find((f) => f.id == 5);
    assert.strictEqual(calc.calculationFormula, '{Price:4} * 2', 'formula text is left alone');
    assert.strictEqual(saved.form.confirmations.c1.message, 'Got {Trigger:1} and {Price:4}');
    assert.deepStrictEqual(result.actions_taken, [], 'nothing was cleaned, so nothing is claimed');
    assert.strictEqual(result.left_dangling.calculations[0].field_id, 5);
    assert.deepStrictEqual(result.left_dangling.calculations[0].matches, ['{Price:4}']);
    assert.strictEqual(result.left_dangling.mergeTags[0].location, 'confirmation');
    assert.match(result.warning, /not rewritten/);
  });

  await t.test('force without cascade reports every dependency it left behind, conditional logic included', async () => {
    const saved = {};
    const manager = cascadeManager(cascadeForm(), saved);

    const result = await manager.deleteField(164, 1, { force: true });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.actions_taken, []);
    assert.deepStrictEqual(result.left_dangling.conditionalLogic.map((d) => d.field_id), [2, 3]);
    assert.strictEqual(saved.form.fields.find((f) => f.id == 2).conditionalLogic.rules.length, 1, 'force leaves the rule in place');
  });

  await t.test('a delete with no dependencies reports no dangling references', async () => {
    const saved = {};
    const manager = cascadeManager(cascadeForm(), saved);

    const result = await manager.deleteField(164, 5, { cascade: true });

    assert.strictEqual(result.success, true);
    assert.strictEqual('left_dangling' in result, false);
    assert.strictEqual('warning' in result, false);
  });

  await t.test('neither flag still refuses, and the refusal names both options', async () => {
    const saved = {};
    const manager = cascadeManager(cascadeForm(), saved);

    const result = await manager.deleteField(164, 1, {});

    assert.strictEqual(result.success, false);
    assert.strictEqual(saved.form, undefined, 'nothing is saved on a refusal');
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

test('FieldManager - addField hardening (adversarial input)', async (t) => {
  const mk = () => new FieldManager(createMockApiClient(), createMockRegistry(), createMockValidator());

  await t.test('does not crash when properties is null', async () => {
    const result = await mk().addField(1, 'text', null);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.field.type, 'text');
  });

  await t.test('does not crash when position is null (real PositionEngine)', async () => {
    const m = mk();
    m.positionEngine = new PositionEngine();
    const result = await m.addField(1, 'text', { label: 'X' }, null);
    assert.strictEqual(result.success, true);
  });

  await t.test('rejects an empty-string field_type', async () => {
    await assert.rejects(() => mk().addField(1, '', { label: 'X' }), /field_type/);
  });

  await t.test('rejects a null field_type', async () => {
    await assert.rejects(() => mk().addField(1, null, { label: 'X' }), /field_type/);
  });

  await t.test('rejects a non-string field_type', async () => {
    await assert.rejects(() => mk().addField(1, 123, { label: 'X' }), /field_type/);
  });
});

// Positioning must honor index 0. calculatePosition() legitimately returns 0
// for prepend / index:0 / before-the-first-field, and a `|| fields.length`
// fallback silently turned every one of those into an append while the
// response reported the fallback index as if the placement succeeded.
test('FieldManager - addField honors position index 0 (falsy-zero regression)', async (t) => {
  const mk = () => {
    const puts = [];
    const apiClient = {
      getForm: async () => ({
        form: {
          id: 1,
          title: 'Test Form',
          fields: [
            { id: 1, type: 'text', label: 'A' },
            { id: 2, type: 'text', label: 'B' },
            { id: 3, type: 'text', label: 'C' }
          ]
        }
      }),
      replaceForm: async (formId, form) => {
        puts.push(form);
        return { form };
      }
    };
    const manager = new FieldManager(apiClient, createMockRegistry(), createMockValidator());
    manager.positionEngine = new PositionEngine();
    return { manager, puts };
  };

  await t.test('prepend inserts at the top and reports index 0', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'prepend' });
    assert.strictEqual(result.position.index, 0);
    assert.deepStrictEqual(puts[0].fields.map((f) => f.label), ['NEW', 'A', 'B', 'C']);
  });

  await t.test('index: 0 inserts at the top and reports index 0', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'index', reference: 0 });
    assert.strictEqual(result.position.index, 0);
    assert.deepStrictEqual(puts[0].fields.map((f) => f.label), ['NEW', 'A', 'B', 'C']);
  });

  await t.test('before the first field inserts at the top and reports index 0', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'before', reference: 1 });
    assert.strictEqual(result.position.index, 0);
    assert.deepStrictEqual(puts[0].fields.map((f) => f.label), ['NEW', 'A', 'B', 'C']);
  });

  await t.test('append still lands at the end', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'append' });
    assert.strictEqual(result.position.index, 3);
    assert.deepStrictEqual(puts[0].fields.map((f) => f.label), ['A', 'B', 'C', 'NEW']);
  });

  await t.test('without a position engine, falls back to append', async () => {
    const { manager, puts } = mk();
    manager.positionEngine = null;
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'prepend' });
    assert.strictEqual(result.position.index, 3);
    assert.deepStrictEqual(puts[0].fields.map((f) => f.label), ['A', 'B', 'C', 'NEW']);
  });
});

// A caller-supplied properties.id must never corrupt the form: entries key on
// field id, so a duplicate id breaks entry values, conditional logic, and merge
// tags. Explicit ids follow the same contract gf_create_form applies via
// assignFieldIds: fresh safe positive integers are preserved; duplicate,
// non-numeric, and out-of-range ids are replaced with a generated id.
test('FieldManager - addField properties.id cannot create duplicate field ids', async (t) => {
  const mk = () => {
    const puts = [];
    const apiClient = {
      getForm: async () => ({
        form: {
          id: 1,
          title: 'Test Form',
          fields: [
            { id: 1, type: 'text', label: 'A' },
            { id: 2, type: 'text', label: 'B' },
            { id: 3, type: 'text', label: 'C' }
          ]
        }
      }),
      replaceForm: async (formId, form) => {
        puts.push(form);
        return { form };
      }
    };
    const manager = new FieldManager(apiClient, createMockRegistry(), createMockValidator());
    manager.positionEngine = new PositionEngine();
    return { manager, puts };
  };

  await t.test('duplicate explicit id is replaced and the form has no colliding ids', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'DUP', id: 2 });
    const ids = puts[0].fields.map((f) => f.id);
    assert.strictEqual(new Set(ids).size, ids.length, `field ids must be unique, got ${ids}`);
    assert.strictEqual(result.field.id, 4);
    assert.ok(
      result.warnings.some((m) => /id/.test(m) && /2/.test(m)),
      'expected a warning that the requested id was not used'
    );
  });

  await t.test('a fresh explicit id is preserved', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'X', id: 100 });
    assert.strictEqual(result.field.id, 100);
    assert.deepStrictEqual(puts[0].fields.map((f) => f.id), [1, 2, 3, 100]);
  });

  await t.test('non-numeric explicit id falls back to a generated id', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'text', { label: 'X', id: 'abc' });
    assert.strictEqual(result.field.id, 4);
  });

  await t.test('out-of-range explicit ids (0, negative, unsafe) fall back to a generated id', async () => {
    for (const bad of [0, -5, 1e308]) {
      const { manager } = mk();
      const result = await manager.addField(1, 'text', { label: 'X', id: bad });
      assert.strictEqual(result.field.id, 4, `id ${bad} must not be used verbatim`);
    }
  });

  await t.test('properties.type cannot override the declared field type', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'text', { label: 'X', type: 'html' });
    assert.strictEqual(result.field.type, 'text');
  });

  await t.test('compound sub-inputs are keyed to the FINAL id when a duplicate id was replaced', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'address', { label: 'Addr', id: 2 });
    assert.strictEqual(result.field.id, 4);
    assert.ok(result.field.inputs.length > 0, 'compound field must have sub-inputs');
    for (const input of result.field.inputs) {
      assert.match(String(input.id), /^4\./, `sub-input ${input.id} must be based on the final id`);
    }
  });
});

// --- delete gate (contributed by @mechkw, PR #13) ---

test('deleteField refuses when deletes are disabled', async () => {
  // deleteForm, deleteEntry and deleteFeed all gate on this; deleteField did not,
  // so a server set to refuse deletions still let a field go — and a deleted field
  // does not land in the Trash the way a form or entry does.
  const api = createMockApiClient();
  api.allowDelete = false;
  const manager = new FieldManager(api, createMockRegistry(), new FieldAwareValidator());

  await assert.rejects(
    () => manager.deleteField(1, 2),
    /GRAVITY_FORMS_ALLOW_DELETE/,
    'the refusal must name the switch that enables it'
  );
});

test('deleteField still works when deletes are permitted', async () => {
  // The control: refusing unconditionally would pass the test above.
  const api = createMockApiClient();
  api.allowDelete = true;
  const manager = new FieldManager(api, createMockRegistry(), new FieldAwareValidator());

  const result = await manager.deleteField(1, 2);
  assert.ok(result, 'a permitted delete still returns a result');
});

// --- multiselect storage mode ---
//
// A multiselect created with no storageType stores its values comma-joined, and
// GF_Field_MultiSelect::to_array() splits on every comma
// (class-gf-field-multiselect.php:417), so "Atlanta, GA" is read back as two
// values. The form editor writes 'json' on every multiselect (js.php:818).

test('addField gives a new multiselect json storage', async () => {
  const api = createMockApiClient();
  const manager = new FieldManager(api, createMockRegistry(), new FieldAwareValidator());

  const result = await manager.addField(1, 'multiselect', {
    label: 'Cities',
    choices: [{ text: 'Atlanta, GA', value: 'Atlanta, GA' }]
  });

  assert.strictEqual(result.field.storageType, 'json');
});

test('addField keeps an explicit legacy storageType on a multiselect', async () => {
  // '' is how a caller matches a field whose stored values are already comma-joined.
  const api = createMockApiClient();
  const manager = new FieldManager(api, createMockRegistry(), new FieldAwareValidator());

  const result = await manager.addField(1, 'multiselect', { label: 'Cities', storageType: '' });

  assert.strictEqual(result.field.storageType, '');
});

test('addField reads inputType, not just type, for the storage mode', async () => {
  // GF_Fields::create() instantiates by inputType, so a post_category field set to
  // multiselect is a GF_Field_MultiSelect.
  const api = createMockApiClient();
  const manager = new FieldManager(api, createMockRegistry(), new FieldAwareValidator());

  const result = await manager.addField(1, 'post_category', { label: 'Category', inputType: 'multiselect' });

  assert.strictEqual(result.field.storageType, 'json');
});

test('addField leaves storageType off a field type that does not need it', async () => {
  // The control: setting it unconditionally would pass the three tests above.
  const api = createMockApiClient();
  const manager = new FieldManager(api, createMockRegistry(), new FieldAwareValidator());

  const result = await manager.addField(1, 'select', { label: 'Pick one' });

  assert.strictEqual(result.field.storageType, undefined);
});


// A position the server cannot honor must not be reported as a plain success.
// Before, a reference to a missing field and an unknown mode both appended the
// field and returned `warnings: []`; the only trace was a stderr log line no
// MCP client sees.
test('FieldManager - addField reports positions it could not honor', async (t) => {
  const mk = (formExtra = {}) => {
    const puts = [];
    const apiClient = {
      getForm: async () => ({
        form: {
          id: 1,
          title: 'Test Form',
          fields: [
            { id: 1, type: 'text', label: 'A' },
            { id: 2, type: 'text', label: 'B' },
            { id: 3, type: 'text', label: 'C' }
          ],
          ...formExtra
        }
      }),
      replaceForm: async (formId, form) => {
        puts.push(form);
        return { form };
      }
    };
    const manager = new FieldManager(apiClient, createMockRegistry(), createMockValidator());
    manager.positionEngine = new PositionEngine();
    return { manager, puts };
  };

  await t.test('after a nonexistent field: appends and says so', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'after', reference: 99999 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.position.index, 3);
    assert.ok(result.warnings.some((w) => /99999/.test(w) && /not found/.test(w)), result.warnings.join('|'));
    assert.deepStrictEqual(puts[0].fields.map((f) => f.label), ['A', 'B', 'C', 'NEW']);
  });

  await t.test('before a nonexistent field: places it and says so', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'before', reference: 99999 });
    assert.ok(result.warnings.some((w) => /99999/.test(w)), result.warnings.join('|'));
  });

  await t.test('an unknown mode throws and does not save the form', async () => {
    const { manager, puts } = mk();
    await assert.rejects(
      () => manager.addField(1, 'text', { label: 'NEW' }, { mode: 'sideways', reference: 1 }),
      /Invalid position mode: sideways.*append, prepend, after, before, index/
    );
    assert.strictEqual(puts.length, 0, 'the form must not be written');
  });

  await t.test('an invalid page number throws and does not save the form', async () => {
    const { manager, puts } = mk();
    await assert.rejects(
      () => manager.addField(1, 'text', { label: 'NEW' }, { page: -1 }),
      /Invalid page number/
    );
    assert.strictEqual(puts.length, 0);
  });

  await t.test('an out-of-range index is clamped and reported', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'index', reference: 50 });
    assert.strictEqual(result.position.index, 3);
    assert.ok(result.warnings.some((w) => /index 50/.test(w)), result.warnings.join('|'));
  });

  await t.test('a page past the last page is reported', async () => {
    const { manager } = mk({ pagination: { type: 'percentage' } });
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { page: 9 });
    assert.ok(result.warnings.some((w) => /Page 9/.test(w)), result.warnings.join('|'));
  });

  await t.test('position.page reports the page the field landed on', async () => {
    const { manager } = mk({
      fields: [
        { id: 1, type: 'text', label: 'A' },
        { id: 2, type: 'page', label: 'Break' },
        { id: 3, type: 'text', label: 'C' }
      ],
      pagination: { type: 'percentage' }
    });
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'after', reference: 3 });
    assert.strictEqual(result.position.page, 2);
  });

  await t.test('a valid position adds no warnings', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'text', { label: 'NEW' }, { mode: 'after', reference: 1 });
    assert.strictEqual(result.position.index, 1);
    assert.deepStrictEqual(result.warnings, []);
  });

  await t.test('position warnings sit beside the field-shape warnings', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'customtype', { label: 'NEW' }, { mode: 'after', reference: 99999 });
    assert.ok(result.warnings.some((w) => /not in the known field registry/.test(w)));
    assert.ok(result.warnings.some((w) => /99999/.test(w)));
  });
});


// `Text` is not a Gravity Forms field type. The type is stored as given (a site
// may register a custom type, and rewriting the caller's input is its own bug),
// but the existing unknown-type warning must point at the lowercase match.
test('FieldManager - addField unknown-type warning names a case-insensitive match', async (t) => {
  const mk = () => {
    const puts = [];
    const apiClient = {
      getForm: async () => ({ form: { id: 1, title: 'T', fields: [] } }),
      replaceForm: async (formId, form) => { puts.push(form); return { form }; }
    };
    return { manager: new FieldManager(apiClient, createMockRegistry(), createMockValidator()), puts };
  };

  await t.test('suggests the registry type that differs only by case, and stores the type as given', async () => {
    const { manager, puts } = mk();
    const result = await manager.addField(1, 'Text', { label: 'X' });
    assert.ok(result.warnings.some((w) => /not in the known field registry/.test(w) && /did you mean 'text'/i.test(w)), result.warnings.join('|'));
    assert.strictEqual(puts[0].fields[0].type, 'Text');
  });

  await t.test('no suggestion when nothing matches', async () => {
    const { manager } = mk();
    const result = await manager.addField(1, 'zzz-custom', { label: 'X' });
    assert.ok(result.warnings.some((w) => /not in the known field registry/.test(w)));
    assert.ok(!result.warnings.some((w) => /did you mean/i.test(w)));
  });
});

// Logic created through the API has no `enabled` key: GFAPI::add_form and this
// server never write it, only the form editor does. GF still applies that logic
// (GFFormsModel::get_field_display() ignores `enabled`), so the delete guard has
// to see it. The fixture carries NO merge tag on the deleted field: a tag would
// make the guard fire on mergeTags and hide this bug, as it did on the live probe.
test('FieldManager.deleteField guards conditional logic that has no `enabled` key', async (t) => {
  const apiForm = () => ({
    id: 191,
    title: 'API-created logic',
    fields: [
      { id: 1, type: 'text', label: 'Trigger' },
      { id: 5, type: 'text', label: 'Follower', conditionalLogic: {
        actionType: 'show', logicType: 'all',
        rules: [{ fieldId: '1', operator: 'is', value: 'y' }]
      } }
    ]
  });
  const build = (form, saved) => {
    const api = {
      getForm: async () => ({ form }),
      replaceForm: async (id, f) => { saved.form = f; return { form: f }; },
      allowDelete: true
    };
    const manager = new FieldManager(api, createMockRegistry(), createMockValidator());
    manager.dependencyTracker = new DependencyTracker();
    return manager;
  };

  await t.test('delete without force or cascade is refused and names the dependent field', async () => {
    const saved = {};
    const result = await build(apiForm(), saved).deleteField(191, 1, {});

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.dependencies.mergeTags.length, 0, 'fixture must not reach the guard through a merge tag');
    assert.strictEqual(result.dependencies.conditionalLogic.length, 1);
    assert.strictEqual(result.dependencies.conditionalLogic[0].field_id, 5);
    assert.strictEqual(saved.form, undefined, 'nothing is saved when the delete is refused');
  });

  await t.test('cascade removes that logic', async () => {
    const saved = {};
    const result = await build(apiForm(), saved).deleteField(191, 1, { cascade: true });

    assert.strictEqual(result.success, true);
    assert.strictEqual(saved.form.fields.find((f) => f.id == 5).conditionalLogic, '');
  });
});
