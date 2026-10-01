/**
 * Field Manager - Core orchestrator for field operations
 * Handles field CRUD operations within REST API v2 constraints
 */

import { createHash } from 'crypto';
import { assignFieldIds, applyNewFieldDefaults, generateCheckboxInputs, reconcileCheckboxInputs } from '../field-definitions/field-registry.js';

/**
 * Field properties that dependents actually consume. Conditional-logic rules
 * compare against the field's VALUES ({fieldId, operator, value}), and
 * calculations / merge tags resolve by field id and read its value — so only
 * changes to the value shape can break a dependent. Cosmetic properties (label,
 * description, cssClass, …) never gate an update.
 *
 * `inputType` belongs here even though `type` is listed: survey, product and
 * post_category fields keep `type` fixed and pick their storage shape with
 * `inputType`, so radio -> checkbox turns one stored value into dot-notation
 * sub-inputs and a dependent rule reads an address that no longer holds it.
 */
const BREAKING_UPDATE_PROPS = ['type', 'inputType', 'choices', 'inputs'];

export class FieldManager {
  constructor(apiClient, fieldRegistry, validator) {
    this.api = apiClient;
    this.registry = fieldRegistry;
    // Required collaborator — always a FieldAwareValidator from
    // createFieldOperations(). It must implement getWarnings(field); a missing
    // method should fail loudly (and is covered by a test) rather than be
    // silently swallowed.
    this.validator = validator;
    this.dependencyTracker = null; // Will be injected
    this.positionEngine = null;    // Will be injected
  }

  /**
   * Add a new field to a form with intelligent defaults
   * @param {number} formId - Target form ID
   * @param {string} fieldType - Field type from registry
   * @param {object} properties - Field configuration
   * @param {object} position - Positioning configuration
   * @returns {object} Field creation result with warnings
   */
  async addField(formId, fieldType, properties = {}, position = {}) {
    if (typeof fieldType !== 'string' || fieldType.trim() === '') {
      throw new Error('field_type is required and must be a non-empty string');
    }
    // Parameter defaults only cover `undefined`; coerce an explicit null so
    // adversarial input can't crash createField or the position engine.
    properties = properties || {};
    position = position || {};

    // The registry is an ENHANCEMENT source, not a gate. Known types get
    // type-specific defaults and sub-inputs. Unknown types (third-party add-ons,
    // GravityKit, custom fields) are still created (Gravity Forms accepts them on
    // save), just without those extras. Callers can pass `inputs`/`choices`
    // explicitly for custom compound/choice fields.
    const fieldDef = this.registry[fieldType] || null;
    const isKnownType = fieldDef !== null;

    // Fetch current form via REST API
    const { form } = await this.api.getForm({ id: formId });

    // Resolve the field id through the same contract gf_create_form uses
    // (assignFieldIds): a caller-supplied fresh safe positive integer is
    // preserved; duplicate / non-numeric / out-of-range ids are replaced with
    // a generated max+1 id. Entries key on field id, so a duplicate would
    // corrupt the form and every subsequent entry.
    const requestedId = properties.id;
    const numbered = assignFieldIds([...(form.fields || []), { id: requestedId }]);
    const fieldId = Number(numbered[numbered.length - 1].id);
    const requestedIdRejected = requestedId !== undefined && Number(requestedId) !== fieldId;

    // Create field with type-specific defaults (none for unknown types)
    const field = this.createField(fieldId, fieldType, properties, fieldDef || {});

    // Known compound types (address, name, …) regenerate sub-inputs from the
    // registry, keyed off the generated field id. Otherwise caller-supplied
    // `inputs` are kept, but their dotted sub-input ids are rebased onto the
    // generated field id so the parent reference matches (mirrors assignFieldIds).
    // A checkbox is registered as compound, but its inputs come from its choices
    // (createField, via applyNewFieldDefaults), not from generateSubInputs, which
    // would replace them with an empty list.
    const isCheckboxStyle = generateCheckboxInputs(field) !== null;
    const isCompoundType = fieldDef?.storage?.type === 'compound' && !isCheckboxStyle;
    if (isCompoundType) {
      field.inputs = this.generateSubInputs(field, fieldDef);
    } else if (Array.isArray(field.inputs)) {
      field.inputs = this.rebaseSubInputIds(field.inputs, fieldId);
    }

    // Normalize layout grid properties (layoutGroupId, layoutGridColumnSpan)
    this.normalizeLayoutProperties(field, formId);
    
    // Refuse a position that is a caller mistake (unknown mode, bad page) before
    // anything is written; placements that fall back (missing reference field,
    // clamped index) are allowed but reported in `warnings` below, because the
    // positioner's own logging goes to stderr, which an MCP client never sees.
    const positionCheck = this.positionEngine
      ? this.positionEngine.validatePositionConfig(position, form.fields || [])
      : { valid: true, errors: [], warnings: [] };
    if (!positionCheck.valid) {
      throw new Error(`Invalid position: ${positionCheck.errors.join('; ')}`);
    }

    // Calculate insertion position (page-aware). Never `||` this result:
    // 0 is a legitimate index (prepend / index:0 / before-the-first-field)
    // and a falsy fallback would silently append instead.
    const insertIndex = this.positionEngine
      ? this.positionEngine.calculatePosition(form.fields || [], position, form.pagination)
      : (form.fields?.length || 0);
    
    // Insert field at calculated position
    if (!form.fields) form.fields = [];
    form.fields.splice(insertIndex, 0, field);
    
    // Replace form via direct PUT (no re-fetch; we already have the full state)
    await this.api.replaceForm(formId, form);

    // Surface field-shape warnings, plus a heads-up when the type is unrecognized.
    const warnings = this.validator.getWarnings(field);
    if (requestedIdRejected) {
      warnings.unshift(
        `Requested field id ${JSON.stringify(requestedId)} could not be used (duplicate, non-numeric, or out of range); assigned id ${fieldId} instead.`
      );
    }
    if (!isKnownType) {
      // Stored as given (a site may register a custom type); only point at the near match.
      const lowerType = fieldType.toLowerCase();
      const caseMatch = Object.keys(this.registry).find((name) => name.toLowerCase() === lowerType);
      const hint = caseMatch ? ` Did you mean '${caseMatch}'? Field types are lowercase.` : '';
      warnings.unshift(
        `Field type '${fieldType}' is not in the known field registry; created without type-specific defaults or sub-inputs. Pass 'inputs'/'choices' explicitly if this type needs them.${hint}`
      );
    }

    warnings.push(...positionCheck.warnings);

    return {
      success: true,
      field: field,
      warnings,
      form_id: formId,
      position: { 
        index: insertIndex, 
        page: this.positionEngine?.getFieldPage?.(field, form.fields) || 1
      }
    };
  }

  /**
   * Update existing field with dependency checking
   */
  async updateField(formId, fieldId, updates = {}, options = {}) {
    const { force = false } = options;

    // Fetch form
    const { form } = await this.api.getForm({ id: formId });

    // Find field
    const fieldIndex = form.fields?.findIndex(f => f.id == fieldId);
    if (fieldIndex === undefined || fieldIndex === -1) {
      throw new Error(`Field ${fieldId} not found in form ${formId}`);
    }

    // Gate BEFORE mutating (matching deleteField): force is required only when
    // the update touches BREAKING_UPDATE_PROPS and hasBreakingDependencies()
    // finds dependents — the same set deleteField gates on. Cosmetic updates
    // always proceed, or agents learn to pass force on every call.
    const dependencies = this.dependencyTracker?.scanFormDependencies(form, fieldId) || {};
    const hasBreakingDeps = typeof this.dependencyTracker?.hasBreakingDependencies === 'function'
      ? this.dependencyTracker.hasBreakingDependencies(dependencies)
      : false;
    const touchesBreakingProps = Object.keys(updates || {})
      .some((key) => BREAKING_UPDATE_PROPS.includes(key));

    if (hasBreakingDeps && touchesBreakingProps && !force) {
      return {
        success: false,
        error: 'Update changes properties (type/choices/inputs) that dependent conditional logic, calculations, or merge tags rely on',
        field_id: fieldId,
        dependencies,
        suggestion: 'Use force=true to update anyway, or limit the update to cosmetic properties (label, description, cssClass, …)'
      };
    }

    // Apply updates
    const originalField = { ...form.fields[fieldIndex] };
    // A checkbox's inputs follow its choices: left stale, an added choice has nowhere
    // to be stored. Removed or moved choices cannot be kept safe, so they are reported.
    const { field: reconciled, warning: inputsWarning } = reconcileCheckboxInputs(originalField, {
      ...originalField,
      ...(updates || {}),
      id: originalField.id // Preserve ID
    });
    form.fields[fieldIndex] = reconciled;
    this.normalizeLayoutProperties(form.fields[fieldIndex], formId);

    // Replace form via direct PUT (no re-fetch; we already have the full state)
    const result = await this.api.replaceForm(formId, form);

    return {
      success: true,
      field: result.form.fields[fieldIndex],
      changes: {
        before: originalField,
        after: result.form.fields[fieldIndex]
      },
      warnings: {
        dependencies: hasBreakingDeps
          ? ['Field has dependents (conditional logic, calculations, or merge tags); value-shape changes (type/choices/inputs) require force']
          : [],
        validationIssues: this.validator.getWarnings(result.form.fields[fieldIndex]),
        inputs: inputsWarning ? [inputsWarning] : []
      }
    };
  }

  /**
   * Delete field with comprehensive dependency analysis
   */
  async deleteField(formId, fieldId, options = {}) {
    // Unlike a form or entry, a deleted field does not go to the Trash: the config
    // is gone and its entry data is orphaned. Gate it as the other deletes are.
    if (!this.api.allowDelete) {
      throw new Error('Delete operations are disabled. Set GRAVITY_FORMS_ALLOW_DELETE=true to enable.');
    }

    const { cascade = false, force = false } = options;
    
    // Fetch form
    const { form } = await this.api.getForm({ id: formId });
    
    // Check field exists
    const field = form.fields?.find(f => f.id == fieldId);
    if (!field) {
      throw new Error(`Field ${fieldId} not found in form ${formId}`);
    }
    
    // Scan dependencies
    const dependencies = this.dependencyTracker?.scanFormDependencies(form, fieldId) || {};
    const hasBreakingDeps = this.dependencyTracker?.hasBreakingDependencies(dependencies);
    
    // cascade means "delete and clean up", so it proceeds like force. The refusal
    // below recommends cascade=true, which is useless if cascade alone is refused.
    const mayProceed = force || cascade;
    if (hasBreakingDeps && !mayProceed) {
      return {
        success: false,
        error: 'Field has dependencies that would break',
        deleted_field: {
          id: field.id,
          type: field.type,
          label: field.label
        },
        dependencies,
        suggestion: 'Use cascade=true to delete and remove its conditional logic rules (calculations and merge tags are reported, not rewritten), or force=true to delete and leave everything as is'
      };
    }
    
    // Remove field
    form.fields = form.fields.filter(f => f.id != fieldId);
    
    // Clean up dependencies if cascade
    let actionsTaken = [];
    if (cascade && hasBreakingDeps) {
      actionsTaken = this.cleanupDependencies(form, fieldId);
    }

    // Report what is still pointing at the deleted field. Only conditional logic
    // is cleaned (and only on cascade); the rest stays and the caller must fix it.
    const leftDangling = {};
    if (!cascade && dependencies.conditionalLogic?.length > 0) {
      leftDangling.conditionalLogic = dependencies.conditionalLogic;
    }
    if (dependencies.calculations?.length > 0) {
      leftDangling.calculations = dependencies.calculations;
    }
    if (dependencies.mergeTags?.length > 0) {
      leftDangling.mergeTags = dependencies.mergeTags;
    }
    const hasDangling = Object.keys(leftDangling).length > 0;
    
    // Replace form via direct PUT (no re-fetch — we already have the full state)
    await this.api.replaceForm(formId, form);

    return {
      success: true,
      deleted_field: {
        id: field.id,
        type: field.type,
        label: field.label
      },
      dependencies,
      actions_taken: actionsTaken,
      ...(hasDangling && {
        left_dangling: leftDangling,
        warning: `Field ${field.id} is deleted but these references to it were not rewritten and will no longer resolve: ${Object.keys(leftDangling).join(', ')}. Fix them on the form.`
      })
    };
  }

  /**
   * Generate unique integer field ID using max+1 pattern
   */
  generateFieldId(existingFields) {
    if (!existingFields || existingFields.length === 0) return 1;
    
    const maxId = existingFields.reduce((max, field) => {
      const id = parseInt(field.id);
      return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    
    return maxId + 1;
  }

  /**
   * Rebase dotted sub-input ids (e.g. "9.1") onto a new parent field id so each
   * sub-input's parent reference matches the field it belongs to. Non-dotted and
   * non-string ids pass through. Mirrors assignFieldIds in the field registry.
   *
   * @param {Array<object>} inputs
   * @param {number|string} baseId
   * @returns {Array<object>}
   */
  rebaseSubInputIds(inputs, baseId) {
    return inputs.map((input) => {
      const hasDottedId = input && typeof input.id === 'string' && input.id.includes('.');
      if (!hasDottedId) {
        return input;
      }
      const sub = input.id.slice(input.id.indexOf('.') + 1);
      return { ...input, id: `${baseId}.${sub}` };
    });
  }

  /**
   * Create field with intelligent defaults from registry
   */
  createField(id, type, properties, fieldDef) {
    // `id` and `type` are resolved by addField and must not be overridable via
    // the properties spread — a caller-supplied properties.id after the spread
    // was how duplicate field ids (form corruption) got in.
    const { id: _requestedId, type: _requestedType, ...safeProperties } = properties;
    // applyNewFieldDefaults runs LAST because it reads the assembled field: a
    // caller-supplied storageType or inputs has to win, and the properties it keys
    // off (`inputType`, `choices`) arrive with safeProperties.
    return applyNewFieldDefaults({
      id,
      type,
      label: properties.label || fieldDef.label || 'Untitled',
      adminLabel: properties.adminLabel || '',
      isRequired: properties.isRequired || false,
      size: properties.size || fieldDef.defaults?.size || 'medium',
      errorMessage: properties.errorMessage || '',
      visibility: properties.visibility || 'visible',
      cssClass: properties.cssClass || '',
      ...this.getTypeSpecificDefaults(type, fieldDef),
      ...safeProperties
    });
  }

  /**
   * Normalize layout grid properties to the editor's storage format.
   *
   * Mirrors the server-side normalization Gravity Forms ships in its
   * abilities API (GF_Abilities_Handler_Forms::normalize_layout_group_ids):
   * the editor stores layoutGroupId as an 8-char lowercase hex string, but
   * agents naturally write friendly names like "row1" or "name-row".
   * Friendly names hash to a stable 8-char hex per form, so the same name
   * passed to later calls lands the field in the same row (GF salts per
   * request because it normalizes a whole form at once; we normalize one
   * field per call, so determinism is what makes row-sharing work).
   *
   * layoutGridColumnSpan is clamped to the editor's 1-12 grid; non-numeric
   * values are dropped so the editor assigns its own span.
   *
   * Mutates and returns the field.
   */
  normalizeLayoutProperties(field, formId) {
    if (typeof field.layoutGridColumnSpan !== 'undefined') {
      const raw = field.layoutGridColumnSpan;
      // Accept only true integers / integer strings — Number() (not parseInt)
      // so "6.5" and "6wide" become NaN instead of being truncated to 6, and
      // empty/whitespace strings are rejected rather than coerced to 0.
      const numeric = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
      const span = numeric ? Number(raw) : NaN;
      if (Number.isInteger(span)) {
        field.layoutGridColumnSpan = Math.min(12, Math.max(1, span));
      } else {
        delete field.layoutGridColumnSpan;
      }
    }

    const groupId = field.layoutGroupId;
    if (typeof groupId === 'string' && groupId !== '' && !/^[0-9a-f]{8}$/.test(groupId)) {
      field.layoutGroupId = createHash('md5').update(`${formId}:${groupId}`).digest('hex').slice(0, 8);
    }

    return field;
  }

  /**
   * Generate compound sub-inputs (address.1, name.3, etc.)
   */
  generateSubInputs(field, fieldDef) {
    const subInputs = [];
    const baseId = field.id;
    
    // Address field sub-inputs
    if (field.type === 'address') {
      const variant = field.addressType || 'us';
      
      if (variant === 'us' || variant === 'international') {
        subInputs.push(
          { id: `${baseId}.1`, label: 'Street Address', name: '' },
          { id: `${baseId}.2`, label: 'Address Line 2', name: '' },
          { id: `${baseId}.3`, label: 'City', name: '' },
          { id: `${baseId}.4`, label: variant === 'us' ? 'State' : 'State / Province', name: '' },
          { id: `${baseId}.5`, label: variant === 'us' ? 'ZIP Code' : 'ZIP / Postal Code', name: '' },
          { id: `${baseId}.6`, label: 'Country', name: '' }
        );
      } else if (variant === 'canadian') {
        subInputs.push(
          { id: `${baseId}.1`, label: 'Street Address', name: '' },
          { id: `${baseId}.2`, label: 'Address Line 2', name: '' },
          { id: `${baseId}.3`, label: 'City', name: '' },
          { id: `${baseId}.4`, label: 'Province', name: '' },
          { id: `${baseId}.5`, label: 'Postal Code', name: '' },
          { id: `${baseId}.6`, label: 'Country', name: '' }
        );
      }
    }
    
    // Name field sub-inputs
    else if (field.type === 'name') {
      const format = field.nameFormat || 'advanced';
      
      if (format === 'advanced') {
        subInputs.push(
          { id: `${baseId}.2`, label: 'Prefix', name: '' },
          { id: `${baseId}.3`, label: 'First', name: '' },
          { id: `${baseId}.4`, label: 'Middle', name: '' },
          { id: `${baseId}.6`, label: 'Last', name: '' },
          { id: `${baseId}.8`, label: 'Suffix', name: '' }
        );
      } else {
        subInputs.push(
          { id: `${baseId}.3`, label: 'First', name: '' },
          { id: `${baseId}.6`, label: 'Last', name: '' }
        );
      }
    }
    
    // Credit card field sub-inputs. GF's field defines five form inputs:
    // .1 Card Number, .2 Expiration, .3 Security Code, .4 Card Type, .5
    // Cardholder Name. Only .1 (masked number) and .4 (card type) are persisted
    // to the entry. (class-gf-field-creditcard.php get_field_input /
    // get_entry_inputs.)
    else if (field.type === 'creditcard') {
      subInputs.push(
        { id: `${baseId}.1`, label: 'Card Number', name: '' },
        { id: `${baseId}.2`, label: 'Expiration Date', name: '' },
        { id: `${baseId}.3`, label: 'Security Code', name: '' },
        { id: `${baseId}.4`, label: 'Card Type', name: '' },
        { id: `${baseId}.5`, label: 'Cardholder Name', name: '' }
      );
    }

    // Chained Select sub-inputs — one dropdown level per sub-input. Validated
    // against the GF Chained Selects add-on (class-gf-field-chainedselect.php
    // import_choices / get_default_inputs): sub-input ids are baseId.N, counted
    // 1,2,…,9,11,12,… SKIPPING multiples of 10 (the .10/.20 slots are reserved),
    // each labelled by its column/level. A fresh field defaults to two levels
    // ("Parents" / "Children"). The level definitions come from any inputs the
    // caller supplied; otherwise the add-on default is used.
    else if (field.type === 'chainedselect') {
      const hasConfiguredLevels = Array.isArray(field.inputs) && field.inputs.length > 0;
      const levels = hasConfiguredLevels
        ? field.inputs
        : [{ label: 'Parents' }, { label: 'Children' }];
      let position = 1;
      for (const level of levels) {
        if (position % 10 === 0) position++; // GF reserves .10/.20/… — skip them
        subInputs.push({ id: `${baseId}.${position}`, label: level.label || '', name: level.name || '' });
        position++;
      }
    }

    return subInputs;
  }

  /**
   * Get type-specific default values
   */
  getTypeSpecificDefaults(type, fieldDef) {
    const defaults = {};
    
    // Add choices for choice-based fields
    if (fieldDef.hasChoices) {
      defaults.choices = [
        { text: 'First Choice', value: 'First Choice' },
        { text: 'Second Choice', value: 'Second Choice' },
        { text: 'Third Choice', value: 'Third Choice' }
      ];
    }
    
    // Add date format for date fields
    if (type === 'date') {
      defaults.dateFormat = 'mdy';
      defaults.dateType = 'datepicker';
    }
    
    // Add time format for time fields
    if (type === 'time') {
      defaults.timeFormat = '12';
    }
    
    return defaults;
  }

  /**
   * Clean up dependencies when cascade deleting.
   * Only conditional logic rules are removed. Returns one line per change made.
   */
  cleanupDependencies(form, fieldId) {
    const actions = [];

    form.fields?.forEach(field => {
      const rules = field.conditionalLogic?.rules;
      if (!Array.isArray(rules)) return;

      const remaining = rules.filter(rule => rule.fieldId != fieldId);
      const removed = rules.length - remaining.length;
      if (removed === 0) return;

      const name = `field ${field.id} ("${field.label || ''}")`;
      if (remaining.length === 0) {
        // GF's server-side visibility check ignores `enabled` and evaluates any
        // non-empty logic object, so zero rules + "hide" would hide the field
        // forever. Empty is what GF itself treats as "no conditional logic".
        field.conditionalLogic = '';
        actions.push(`Removed ${removed} conditional logic rule(s) referencing field ${fieldId} from ${name}; no rules were left, so its conditional logic was removed`);
      } else {
        field.conditionalLogic.rules = remaining;
        actions.push(`Removed ${removed} conditional logic rule(s) referencing field ${fieldId} from ${name}`);
      }
    });

    // Calculations and merge tags are not rewritten: stripping a token changes
    // what a formula computes, so deleteField reports them instead.
    return actions;
  }
}
