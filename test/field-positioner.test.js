/**
 * Unit tests for PositionEngine class
 * Tests intelligent field positioning including page-aware placement
 */

import test from 'node:test';
import assert from 'node:assert';
import { PositionEngine } from '../src/field-operations/field-positioner.js';

// Create test fields with page breaks
const createTestFields = () => [
  { id: 1, type: 'text', label: 'Field 1' },
  { id: 2, type: 'email', label: 'Field 2' },
  { id: 3, type: 'page', label: 'Page Break 1' },
  { id: 4, type: 'text', label: 'Field 4' },
  { id: 5, type: 'textarea', label: 'Field 5' },
  { id: 6, type: 'page', label: 'Page Break 2' },
  { id: 7, type: 'number', label: 'Field 7' },
  { id: 8, type: 'select', label: 'Field 8' }
];

test('PositionEngine - calculatePosition basic modes', async (t) => {
  const engine = new PositionEngine();

  await t.test('append mode adds to end', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, { mode: 'append' });
    assert.strictEqual(position, fields.length);
  });

  await t.test('prepend mode adds to beginning', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, { mode: 'prepend' });
    assert.strictEqual(position, 0);
  });

  await t.test('after mode positions after reference field', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, { 
      mode: 'after', 
      reference: 4 
    });
    // Field 4 is at index 3, so after would be index 4
    assert.strictEqual(position, 4);
  });

  await t.test('before mode positions before reference field', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, { 
      mode: 'before', 
      reference: 4 
    });
    // Field 4 is at index 3, so before would be index 3
    assert.strictEqual(position, 3);
  });

  await t.test('index mode uses specific index', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, { 
      mode: 'index', 
      reference: 5 
    });
    assert.strictEqual(position, 5);
  });

  await t.test('defaults to append with no config', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields);
    assert.strictEqual(position, fields.length);
  });
});

test('PositionEngine - page aware positioning', async (t) => {
  const engine = new PositionEngine();

  await t.test('append to specific page', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, {
      mode: 'append',
      page: 2
    }, { enabled: true });
    
    // Should add after field 5 (last field on page 2 before page break)
    assert.strictEqual(position, 5);
  });

  await t.test('prepend to specific page', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, {
      mode: 'prepend',
      page: 2
    }, { enabled: true });
    
    // Should add at beginning of page 2 (after page break 1)
    assert.strictEqual(position, 3);
  });

  await t.test('append to first page', () => {
    const fields = createTestFields();
    const position = engine.calculatePosition(fields, {
      mode: 'append',
      page: 1
    }, { enabled: true });
    
    // Should add before first page break
    assert.strictEqual(position, 2);
  });

  await t.test('handles empty page', () => {
    const fields = [
      { id: 1, type: 'text' },
      { id: 2, type: 'page' },
      { id: 3, type: 'page' }, // Empty page 2
      { id: 4, type: 'text' }
    ];
    
    const position = engine.calculatePosition(fields, {
      mode: 'append',
      page: 2
    }, { enabled: true });
    
    // Should add after first page break
    assert.strictEqual(position, 2);
  });
});

test('PositionEngine - getPageBoundaries', async (t) => {
  const engine = new PositionEngine();

  await t.test('identifies page break fields', () => {
    const fields = createTestFields();
    const boundaries = engine.getPageBoundaries(fields);
    
    assert.strictEqual(boundaries.length, 2);
    assert.strictEqual(boundaries[0].id, 3);
    assert.strictEqual(boundaries[1].id, 6);
  });

  await t.test('handles no page breaks', () => {
    const fields = [
      { id: 1, type: 'text' },
      { id: 2, type: 'email' }
    ];
    const boundaries = engine.getPageBoundaries(fields);
    
    assert.strictEqual(boundaries.length, 0);
  });
});

test('PositionEngine - getFieldsForPage', async (t) => {
  const engine = new PositionEngine();

  await t.test('gets fields for page 1', () => {
    const fields = createTestFields();
    const pageFields = engine.getFieldsForPage(fields, 1);
    
    assert.strictEqual(pageFields.length, 2);
    assert.strictEqual(pageFields[0].id, 1);
    assert.strictEqual(pageFields[1].id, 2);
  });

  await t.test('gets fields for page 2', () => {
    const fields = createTestFields();
    const pageFields = engine.getFieldsForPage(fields, 2);
    
    assert.strictEqual(pageFields.length, 2);
    assert.strictEqual(pageFields[0].id, 4);
    assert.strictEqual(pageFields[1].id, 5);
  });

  await t.test('gets fields for page 3', () => {
    const fields = createTestFields();
    const pageFields = engine.getFieldsForPage(fields, 3);
    
    assert.strictEqual(pageFields.length, 2);
    assert.strictEqual(pageFields[0].id, 7);
    assert.strictEqual(pageFields[1].id, 8);
  });

  await t.test('returns empty for non-existent page', () => {
    const fields = createTestFields();
    const pageFields = engine.getFieldsForPage(fields, 10);
    
    assert.strictEqual(pageFields.length, 0);
  });
});

test('PositionEngine - getFieldPage', async (t) => {
  const engine = new PositionEngine();

  await t.test('determines field page correctly', () => {
    const fields = createTestFields();
    
    assert.strictEqual(engine.getFieldPage(fields[0], fields), 1); // Field 1
    assert.strictEqual(engine.getFieldPage(fields[1], fields), 1); // Field 2
    assert.strictEqual(engine.getFieldPage(fields[3], fields), 2); // Field 4
    assert.strictEqual(engine.getFieldPage(fields[4], fields), 2); // Field 5
    assert.strictEqual(engine.getFieldPage(fields[6], fields), 3); // Field 7
    assert.strictEqual(engine.getFieldPage(fields[7], fields), 3); // Field 8
  });

  await t.test('returns null for non-existent field', () => {
    const fields = createTestFields();
    const nonExistentField = { id: 999, type: 'text' };
    
    assert.strictEqual(engine.getFieldPage(nonExistentField, fields), null);
  });
});

test('PositionEngine - validatePositionConfig', async (t) => {
  const engine = new PositionEngine();

  await t.test('validates valid configuration', () => {
    const fields = createTestFields();
    const result = engine.validatePositionConfig({
      mode: 'after',
      reference: 4,
      page: 2
    }, fields);
    
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test('detects invalid mode', () => {
    const fields = createTestFields();
    const result = engine.validatePositionConfig({
      mode: 'invalid'
    }, fields);
    
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors[0].includes('Invalid position mode'));
  });

  await t.test('warns about missing reference', () => {
    const fields = createTestFields();
    const result = engine.validatePositionConfig({
      mode: 'after'
    }, fields);
    
    assert.strictEqual(result.valid, true); // Warning, not error
    assert.ok(result.warnings[0].includes('without reference'));
  });

  await t.test('warns about non-existent reference field', () => {
    const fields = createTestFields();
    const result = engine.validatePositionConfig({
      mode: 'after',
      reference: 999
    }, fields);
    
    assert.strictEqual(result.valid, true); // Warning, not error
    assert.ok(result.warnings[0].includes('not found'));
  });

  await t.test('validates page number', () => {
    const fields = createTestFields();
    const result = engine.validatePositionConfig({
      page: -1
    }, fields);
    
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors[0].includes('Invalid page number'));
  });

  await t.test('warns about page exceeding total', () => {
    const fields = createTestFields();
    const result = engine.validatePositionConfig({
      page: 10
    }, fields);
    
    assert.strictEqual(result.valid, true); // Warning, not error
    assert.ok(result.warnings[0].includes('exceeds total pages'));
  });
});

test('PositionEngine - getPositionSummary', async (t) => {
  const engine = new PositionEngine();

  await t.test('generates accurate summary', () => {
    const fields = createTestFields();
    const field = { id: 99, type: 'text' };
    const summary = engine.getPositionSummary(fields, 3, field);
    
    assert.strictEqual(summary.totalFields, 8);
    assert.strictEqual(summary.totalPages, 3);
    assert.strictEqual(summary.insertedAt, 3);
    assert.strictEqual(summary.afterField, 3); // Page break field (id: 3)
    assert.strictEqual(summary.beforeField, 4); // Text field (id: 4)
  });
});