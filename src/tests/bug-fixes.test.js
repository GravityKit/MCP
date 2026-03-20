#!/usr/bin/env node

/**
 * Bug Fix Regression Tests for Gravity MCP
 * Each test exposes a specific bug, then verifies the fix.
 */

import { TestRunner, TestAssert } from './helpers.js';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcDir = join(__dirname, '..');
const projectDir = join(__dirname, '..', '..');

const suite = new TestRunner('Bug Fix Regression Tests');

// =================================
// Bug #2: console.log bypasses MCP logger
// =================================

suite.test('Bug #2: No console.log/warn in src/ outside tests/ and logger.js', () => {
  const jsFiles = findJsFiles(srcDir, ['tests']);
  const violations = [];

  for (const filePath of jsFiles) {
    // Skip the logger itself — it legitimately uses console.log/error
    if (filePath.endsWith('logger.js')) continue;

    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match console.log( or console.warn( that are not comments
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue; // skip comments
      if (/console\.(log|warn)\(/.test(line)) {
        violations.push(`${filePath}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  TestAssert.equal(
    violations.length,
    0,
    `Found ${violations.length} console.log/warn violations:\n${violations.join('\n')}`
  );
});

// =================================
// Bug #4: mcp.json wrong tool count and phantom tool
// =================================

suite.test('Bug #4: mcp.json tool count matches index.js tools', () => {
  const mcpJson = JSON.parse(readFileSync(join(projectDir, 'mcp.json'), 'utf8'));
  const indexSrc = readFileSync(join(srcDir, 'index.js'), 'utf8');
  const fieldOpsSrc = readFileSync(join(srcDir, 'field-operations', 'index.js'), 'utf8');

  // Extract tool names from index.js
  const indexToolNames = [];
  const nameRegex = /name:\s*'(gf_[a-z_]+)'/g;
  let match;
  while ((match = nameRegex.exec(indexSrc)) !== null) {
    // Only count tools in the ListToolsRequestSchema handler, not in switch cases
    indexToolNames.push(match[1]);
  }
  // Extract from fieldOperationTools
  while ((match = nameRegex.exec(fieldOpsSrc)) !== null) {
    indexToolNames.push(match[1]);
  }
  // mcp.json tools
  const mcpToolNames = mcpJson.tools.map(t => t.name);

  TestAssert.equal(mcpJson.capabilities.tools, 27, 'mcp.json capabilities.tools should be 27');
  TestAssert.equal(mcpToolNames.length, 27, 'mcp.json should list 27 tools');
});

suite.test('Bug #4: No phantom gf_submit_form tool in mcp.json', () => {
  const mcpJson = JSON.parse(readFileSync(join(projectDir, 'mcp.json'), 'utf8'));
  const mcpToolNames = mcpJson.tools.map(t => t.name);

  TestAssert.isFalse(
    mcpToolNames.includes('gf_submit_form'),
    'mcp.json should not contain phantom gf_submit_form tool'
  );
  TestAssert.isTrue(
    mcpToolNames.includes('gf_submit_form_data'),
    'mcp.json should contain gf_submit_form_data'
  );
});

suite.test('Bug #4: mcp.json includes field operation tools', () => {
  const mcpJson = JSON.parse(readFileSync(join(projectDir, 'mcp.json'), 'utf8'));
  const mcpToolNames = mcpJson.tools.map(t => t.name);

  const fieldOpTools = ['gf_add_field', 'gf_update_field', 'gf_delete_field', 'gf_list_field_types'];
  for (const tool of fieldOpTools) {
    TestAssert.isTrue(
      mcpToolNames.includes(tool),
      `mcp.json should include ${tool}`
    );
  }
});

// =================================
// Bug #5: No MCP tool annotations
// =================================

suite.test('Bug #5: All 24 inline tools have annotations', () => {
  const indexSrc = readFileSync(join(srcDir, 'index.js'), 'utf8');

  // Find tool objects in ListToolsRequestSchema by matching name + annotations pattern
  // Each tool block should have annotations
  // Only count in the ListToolsRequestSchema section (before CallToolRequestSchema)
  const schemaSection = indexSrc.split('CallToolRequestSchema')[0];
  const toolNames = [];
  const nameRegex = /name:\s*'(gf_[a-z_]+)'/g;
  let m;
  while ((m = nameRegex.exec(schemaSection)) !== null) {
    toolNames.push(m[1]);
  }

  // Check each tool has annotations in the schema section
  for (const toolName of toolNames) {
    // Find the tool definition block
    const toolPattern = new RegExp(
      `name:\\s*'${toolName}'[\\s\\S]*?annotations:\\s*\\{[^}]+\\}`,
      'm'
    );
    TestAssert.isTrue(
      toolPattern.test(schemaSection),
      `Tool ${toolName} should have annotations object`
    );
  }
});

suite.test('Bug #5: Field operation tools have annotations', () => {
  const fieldOpsSrc = readFileSync(join(srcDir, 'field-operations', 'index.js'), 'utf8');

  const fieldTools = ['gf_add_field', 'gf_update_field', 'gf_delete_field', 'gf_list_field_types'];
  for (const toolName of fieldTools) {
    const toolPattern = new RegExp(
      `name:\\s*'${toolName}'[\\s\\S]*?annotations:\\s*\\{[^}]+\\}`,
      'm'
    );
    TestAssert.isTrue(
      toolPattern.test(fieldOpsSrc),
      `Field tool ${toolName} should have annotations object`
    );
  }
});

suite.test('Bug #5: Read-only tools have readOnlyHint: true', () => {
  const indexSrc = readFileSync(join(srcDir, 'index.js'), 'utf8');
  const fieldOpsSrc = readFileSync(join(srcDir, 'field-operations', 'index.js'), 'utf8');
  const allSrc = indexSrc + fieldOpsSrc;

  const readOnlyTools = [
    'gf_list_forms', 'gf_get_form', 'gf_validate_form',
    'gf_list_entries', 'gf_get_entry',
    'gf_validate_submission',
    'gf_list_feeds', 'gf_get_feed', 'gf_list_form_feeds',
    'gf_get_field_filters', 'gf_get_results',
    'gf_list_field_types'
  ];

  for (const toolName of readOnlyTools) {
    const pattern = new RegExp(
      `name:\\s*'${toolName}'[\\s\\S]*?readOnlyHint:\\s*true`
    );
    TestAssert.isTrue(
      pattern.test(allSrc),
      `${toolName} should have readOnlyHint: true`
    );
  }
});

suite.test('Bug #5: Delete tools have destructiveHint: true', () => {
  const indexSrc = readFileSync(join(srcDir, 'index.js'), 'utf8');
  const fieldOpsSrc = readFileSync(join(srcDir, 'field-operations', 'index.js'), 'utf8');
  const allSrc = indexSrc + fieldOpsSrc;

  const deleteTools = ['gf_delete_form', 'gf_delete_entry', 'gf_delete_feed', 'gf_delete_field'];

  for (const toolName of deleteTools) {
    const pattern = new RegExp(
      `name:\\s*'${toolName}'[\\s\\S]*?destructiveHint:\\s*true`
    );
    TestAssert.isTrue(
      pattern.test(allSrc),
      `${toolName} should have destructiveHint: true`
    );
  }
});

// =================================
// Bug #7: _variant/_meta in API payloads
// =================================

suite.test('Bug #7: validateField strips _variant and _meta from output', async () => {
  const { FieldAwareValidator } = await import('../config/field-validation.js');

  const field = {
    id: 1,
    type: 'text',
    label: 'Test Field'
  };

  const result = FieldAwareValidator.validateField(field);
  TestAssert.isTrue(result.isValid, 'Field should be valid');
  TestAssert.equal(result.field._variant, undefined, 'Validated field should not contain _variant');
  TestAssert.equal(result.field._meta, undefined, 'Validated field should not contain _meta');
});

suite.test('Bug #7: validateFormFields strips _variant and _meta from all fields', async () => {
  const { FieldAwareValidator } = await import('../config/field-validation.js');

  const fields = [
    { id: 1, type: 'text', label: 'Text Field' },
    { id: 2, type: 'email', label: 'Email Field' }
  ];

  const validated = FieldAwareValidator.validateFormFields(fields);
  for (const field of validated) {
    TestAssert.equal(field._variant, undefined, `Field ${field.id} should not have _variant`);
    TestAssert.equal(field._meta, undefined, `Field ${field.id} should not have _meta`);
  }
});

// =================================
// Bug #8: Field ops swallow errors without isError
// =================================

suite.test('Bug #8: gf_add_field throws errors instead of swallowing them', async () => {
  const { fieldOperationHandlers } = await import('../field-operations/index.js');

  // Create a mock fieldManager that throws
  const mockFieldOps = {
    fieldManager: {
      addField: async () => { throw new Error('API connection failed'); }
    }
  };

  let threw = false;
  try {
    await fieldOperationHandlers.gf_add_field(
      { form_id: 1, field_type: 'text' },
      mockFieldOps
    );
  } catch (error) {
    threw = true;
    TestAssert.isTrue(
      error.message.includes('API connection failed'),
      'Error message should propagate'
    );
  }

  TestAssert.isTrue(threw, 'gf_add_field should throw on error, not swallow it');
});

suite.test('Bug #8: gf_update_field throws errors instead of swallowing them', async () => {
  const { fieldOperationHandlers } = await import('../field-operations/index.js');

  const mockFieldOps = {
    fieldManager: {
      updateField: async () => { throw new Error('Field not found'); }
    }
  };

  let threw = false;
  try {
    await fieldOperationHandlers.gf_update_field(
      { form_id: 1, field_id: 99, properties: { label: 'x' } },
      mockFieldOps
    );
  } catch (error) {
    threw = true;
  }

  TestAssert.isTrue(threw, 'gf_update_field should throw on error');
});

suite.test('Bug #8: gf_delete_field throws errors instead of swallowing them', async () => {
  const { fieldOperationHandlers } = await import('../field-operations/index.js');

  const mockFieldOps = {
    fieldManager: {
      deleteField: async () => { throw new Error('Permission denied'); }
    }
  };

  let threw = false;
  try {
    await fieldOperationHandlers.gf_delete_field(
      { form_id: 1, field_id: 1 },
      mockFieldOps
    );
  } catch (error) {
    threw = true;
  }

  TestAssert.isTrue(threw, 'gf_delete_field should throw on error');
});

// =================================
// Bug #9: Name field sub-input IDs inverted
// =================================

suite.test('Bug #9: Name field registry has correct sub-input mapping', async () => {
  const { fieldRegistry } = await import('../field-definitions/field-registry.js');

  const nameField = fieldRegistry.name;
  TestAssert.exists(nameField, 'Name field should exist in registry');
  TestAssert.exists(nameField.storage.subInputs, 'Name field should have subInputs');

  // Gravity Forms actual mapping: .2=prefix, .3=first, .4=middle, .6=last, .8=suffix
  const subInputs = nameField.storage.subInputs;
  TestAssert.equal(subInputs['2'], 'prefix', '.2 should map to prefix');
  TestAssert.equal(subInputs['3'], 'first', '.3 should map to first');
  TestAssert.equal(subInputs['4'], 'middle', '.4 should map to middle');
  TestAssert.equal(subInputs['6'], 'last', '.6 should map to last');
  TestAssert.equal(subInputs['8'], 'suffix', '.8 should map to suffix');
});

suite.test('Bug #9: generateCompoundInputs matches registry for name field', async () => {
  const { generateCompoundInputs } = await import('../field-definitions/field-registry.js');

  const field = { id: 5, type: 'name', nameFormat: 'advanced' };
  const inputs = generateCompoundInputs(field);

  TestAssert.exists(inputs, 'Should generate inputs for name field');

  // Check that .2 = Prefix, .3 = First (matching GF source)
  const prefixInput = inputs.find(i => i.id === '5.2');
  const firstInput = inputs.find(i => i.id === '5.3');

  TestAssert.exists(prefixInput, 'Should have prefix input at .2');
  TestAssert.equal(prefixInput.label, 'Prefix', '.2 label should be Prefix');
  TestAssert.exists(firstInput, 'Should have first input at .3');
  TestAssert.equal(firstInput.label, 'First', '.3 label should be First');
});

// =================================
// Bug #20: crypto npm dependency
// =================================

suite.test('Bug #20: package.json does not list crypto as dependency', () => {
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  const deps = pkg.dependencies || {};

  TestAssert.equal(
    deps.crypto,
    undefined,
    'crypto should not be in dependencies (it is a Node built-in)'
  );
});

// =================================
// Bug #21: form-data unused dependency
// =================================

suite.test('Bug #21: No form-data import in src/ files', () => {
  const jsFiles = findJsFiles(srcDir, ['tests']);
  const imports = [];

  for (const filePath of jsFiles) {
    const content = readFileSync(filePath, 'utf8');
    if (/import\s.*['"]form-data['"]/.test(content) || /require\(['"]form-data['"]\)/.test(content)) {
      imports.push(filePath);
    }
  }

  TestAssert.equal(
    imports.length,
    0,
    `Found form-data imports in: ${imports.join(', ')}`
  );
});

suite.test('Bug #21: package.json does not list form-data as dependency', () => {
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  const deps = pkg.dependencies || {};

  TestAssert.equal(
    deps['form-data'],
    undefined,
    'form-data should not be in dependencies (unused)'
  );
});

// =================================
// Bug #23: mcp.json version mismatch
// =================================

suite.test('Bug #23: mcp.json version matches package.json version', () => {
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  const mcpJson = JSON.parse(readFileSync(join(projectDir, 'mcp.json'), 'utf8'));

  TestAssert.equal(
    mcpJson.version,
    pkg.version,
    `mcp.json version (${mcpJson.version}) should match package.json version (${pkg.version})`
  );
});

// =================================
// Bug #24: Feature filter wrong key name
// =================================

suite.test('Bug #24: Filtering by "conditional" feature returns >0 results', async () => {
  const { fieldOperationHandlers } = await import('../field-operations/index.js');
  const fieldRegistry = (await import('../field-definitions/field-registry.js')).default;

  const result = await fieldOperationHandlers.gf_list_field_types(
    { feature: 'conditional' },
    { fieldRegistry }
  );

  TestAssert.isTrue(
    result.total > 0,
    `Filtering by conditional feature should return >0 results, got ${result.total}`
  );
});

suite.test('Bug #24: featureMap uses supportsConditionalLogic not supportsConditional', () => {
  const fieldOpsSrc = readFileSync(join(srcDir, 'field-operations', 'index.js'), 'utf8');

  TestAssert.isTrue(
    fieldOpsSrc.includes("conditional: 'supportsConditionalLogic'"),
    'featureMap should map conditional to supportsConditionalLogic'
  );
  TestAssert.isFalse(
    fieldOpsSrc.includes("conditional: 'supportsConditional'"),
    'featureMap should NOT map conditional to supportsConditional'
  );
});

// =================================
// Bug #25: gf_delete_feed missing ALLOW_DELETE in description
// =================================

suite.test('Bug #25: gf_delete_feed description mentions ALLOW_DELETE', () => {
  const indexSrc = readFileSync(join(srcDir, 'index.js'), 'utf8');

  // Find the gf_delete_feed tool definition and check its description
  const feedDeleteMatch = indexSrc.match(
    /name:\s*'gf_delete_feed'[\s\S]*?description:\s*'([^']+)'/
  );

  TestAssert.exists(feedDeleteMatch, 'gf_delete_feed should be defined in index.js');
  TestAssert.isTrue(
    feedDeleteMatch[1].includes('ALLOW_DELETE'),
    `gf_delete_feed description should mention ALLOW_DELETE, got: "${feedDeleteMatch[1]}"`
  );
});

// =================================
// Helpers
// =================================

/**
 * Recursively find .js files in a directory, excluding specified subdirs
 */
function findJsFiles(dir, excludeDirs = []) {
  const results = [];
  const items = readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    if (item.isDirectory()) {
      if (!excludeDirs.includes(item.name)) {
        results.push(...findJsFiles(join(dir, item.name), excludeDirs));
      }
    } else if (item.name.endsWith('.js')) {
      results.push(join(dir, item.name));
    }
  }

  return results;
}

export default suite;
