/**
 * Unit tests for DependencyTracker class
 * Tests dependency scanning for conditional logic, calculations, merge tags
 */

import test from 'node:test';
import assert from 'node:assert';
import { DependencyTracker } from '../src/field-operations/field-dependencies.js';

// Sample form with various dependencies
const createTestForm = () => ({
  id: 1,
  title: 'Test Form',
  fields: [
    {
      id: 1,
      type: 'text',
      label: 'Name',
      conditionalLogic: {
        enabled: true,
        rules: [
          { fieldId: 2, operator: 'is', value: 'yes' }
        ]
      }
    },
    {
      id: 2,
      type: 'radio',
      label: 'Subscribe',
      choices: [
        { text: 'Yes', value: 'yes' },
        { text: 'No', value: 'no' }
      ]
    },
    {
      id: 3,
      type: 'number',
      label: 'Price',
      enableCalculation: true,
      calculationFormula: '{Quantity:4} * 10 + {Tax:5}'
    },
    {
      id: 4,
      type: 'number',
      label: 'Quantity'
    },
    {
      id: 5,
      type: 'number',
      label: 'Tax'
    },
    {
      id: 6,
      type: 'text',
      label: 'Dynamic Field',
      allowsPrepopulate: true,
      inputName: 'dynamic_param'
    },
    {
      id: 7,
      type: 'html',
      content: 'Total: {Price:3}'
    },
    {
      id: 8,
      type: 'text',
      label: 'Referrer',
      defaultValue: '{dynamic_param}'
    }
  ],
  notifications: {
    notification_1: {
      name: 'Admin Notification',
      subject: 'New submission from {Name:1}',
      message: 'Name: {Name:1}\nQuantity: {Quantity:4}\nPrice: {Price:3}',
      to: '{Email:9}'
    }
  },
  confirmations: {
    confirmation_1: {
      name: 'Thank You',
      type: 'message',
      message: 'Thank you {Name:1}, your total is {Price:3}'
    }
  }
});

test('DependencyTracker - scanConditionalLogic', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('finds conditional logic dependencies', () => {
    const form = createTestForm();
    const dependencies = { conditionalLogic: [] };
    
    tracker.scanConditionalLogic(form, 2, dependencies);
    
    assert.strictEqual(dependencies.conditionalLogic.length, 1);
    assert.strictEqual(dependencies.conditionalLogic[0].field_id, 1);
    assert.strictEqual(dependencies.conditionalLogic[0].field_label, 'Name');
    assert.strictEqual(dependencies.conditionalLogic[0].rule_count, 1);
  });

  await t.test('handles no conditional logic dependencies', () => {
    const form = createTestForm();
    const dependencies = { conditionalLogic: [] };
    
    tracker.scanConditionalLogic(form, 999, dependencies);
    
    assert.strictEqual(dependencies.conditionalLogic.length, 0);
  });
});

test('DependencyTracker - scanCalculations', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('finds calculation formula dependencies', () => {
    const form = createTestForm();
    const dependencies = { calculations: [] };
    
    tracker.scanCalculations(form, 4, dependencies);
    
    assert.strictEqual(dependencies.calculations.length, 1);
    assert.strictEqual(dependencies.calculations[0].field_id, 3);
    assert.strictEqual(dependencies.calculations[0].field_label, 'Price');
    assert.ok(dependencies.calculations[0].formula.includes('{Quantity:4}'));
  });

  await t.test('finds multiple field references in formula', () => {
    const form = createTestForm();
    const dependencies = { calculations: [] };
    
    // Check for field 5 (Tax)
    tracker.scanCalculations(form, 5, dependencies);
    
    assert.strictEqual(dependencies.calculations.length, 1);
    assert.strictEqual(dependencies.calculations[0].field_id, 3);
    assert.ok(dependencies.calculations[0].matches.some(m => m.includes(':5')));
  });
});

test('DependencyTracker - scanMergeTags', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('finds merge tags in notifications', () => {
    const form = createTestForm();
    const dependencies = { mergeTags: [] };
    
    tracker.scanMergeTags(form, 1, dependencies);
    
    // Should find in subject and message
    const notificationTags = dependencies.mergeTags.filter(d => d.location === 'notification');
    assert.strictEqual(notificationTags.length, 2);
    assert.ok(notificationTags.some(d => d.field === 'subject'));
    assert.ok(notificationTags.some(d => d.field === 'message'));
  });

  await t.test('finds merge tags in confirmations', () => {
    const form = createTestForm();
    const dependencies = { mergeTags: [] };
    
    tracker.scanMergeTags(form, 1, dependencies);
    
    const confirmationTags = dependencies.mergeTags.filter(d => d.location === 'confirmation');
    assert.strictEqual(confirmationTags.length, 1);
    assert.strictEqual(confirmationTags[0].field, 'message');
  });

  await t.test('finds merge tags in field content', () => {
    const form = createTestForm();
    const dependencies = { mergeTags: [] };
    
    tracker.scanMergeTags(form, 3, dependencies);
    
    const fieldTags = dependencies.mergeTags.filter(d => d.location === 'field');
    assert.strictEqual(fieldTags.length, 1);
    assert.strictEqual(fieldTags[0].field_id, 7);
    assert.strictEqual(fieldTags[0].property, 'content');
  });
});

test('DependencyTracker - scanDynamicPopulation', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('finds dynamic population references', () => {
    const form = createTestForm();
    const dependencies = { dynamicPopulation: [] };
    
    tracker.scanDynamicPopulation(form, 6, dependencies);
    
    // Should find field 8 using the parameter and field 6 accepting it
    assert.strictEqual(dependencies.dynamicPopulation.length, 2);
    
    const reference = dependencies.dynamicPopulation.find(d => d.field_id === 8);
    assert.ok(reference);
    assert.strictEqual(reference.parameter, 'dynamic_param');
    assert.strictEqual(reference.usage, 'default_value');
    
    const accepts = dependencies.dynamicPopulation.find(d => d.usage === 'accepts_population');
    assert.ok(accepts);
    assert.strictEqual(accepts.field_id, 6);
  });
});

test('DependencyTracker - scanFormDependencies', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('scans all dependency types', () => {
    const form = createTestForm();
    const dependencies = tracker.scanFormDependencies(form, 1);
    
    // Field 1 should have dependencies in confirmations and notifications
    assert.ok(dependencies.mergeTags.length > 0);
    assert.strictEqual(dependencies.conditionalLogic.length, 0); // Field 1 doesn't appear in conditional logic
    assert.strictEqual(dependencies.calculations.length, 0); // Field 1 not in calculations
  });

  await t.test('returns comprehensive dependency report', () => {
    const form = createTestForm();
    const dependencies = tracker.scanFormDependencies(form, 4);
    
    // Field 4 (Quantity) is used in calculations and notifications
    assert.ok(dependencies.calculations.length > 0);
    assert.ok(dependencies.mergeTags.length > 0);
  });
});

test('DependencyTracker - hasBreakingDependencies', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('detects breaking dependencies', () => {
    const dependencies = {
      conditionalLogic: [{ field_id: 1 }],
      calculations: [],
      mergeTags: [],
      dynamicPopulation: []
    };
    
    assert.strictEqual(tracker.hasBreakingDependencies(dependencies), true);
  });

  await t.test('detects no breaking dependencies', () => {
    const dependencies = {
      conditionalLogic: [],
      calculations: [],
      mergeTags: [],
      dynamicPopulation: [{ usage: 'accepts_population' }]
    };
    
    assert.strictEqual(tracker.hasBreakingDependencies(dependencies), false);
  });
});

test('DependencyTracker - generateDependencySummary', async (t) => {
  const tracker = new DependencyTracker();

  await t.test('generates summary for multiple dependencies', () => {
    const dependencies = {
      conditionalLogic: [{ field_id: 1 }, { field_id: 2 }],
      calculations: [{ field_id: 3 }],
      mergeTags: [{ location: 'notification' }],
      dynamicPopulation: []
    };
    
    const summary = tracker.generateDependencySummary(dependencies);
    
    assert.ok(summary.includes('2 conditional logic rule(s)'));
    assert.ok(summary.includes('1 calculation formula(s)'));
    assert.ok(summary.includes('1 merge tag reference(s)'));
  });

  await t.test('generates summary for no dependencies', () => {
    const dependencies = {
      conditionalLogic: [],
      calculations: [],
      mergeTags: [],
      dynamicPopulation: []
    };
    
    const summary = tracker.generateDependencySummary(dependencies);
    assert.strictEqual(summary, 'No dependencies found');
  });
});