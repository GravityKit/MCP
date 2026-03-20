/**
 * Position Engine - Intelligent field positioning with page awareness
 * Handles append, prepend, after, before, index, and page-specific positioning
 */

import logger from '../utils/logger.js';

export class PositionEngine {
  /**
   * Calculate the insertion index for a new field
   * @param {array} fields - Existing form fields
   * @param {object} positionConfig - Positioning configuration
   * @param {object} pagination - Form pagination settings
   * @returns {number} Index where field should be inserted
   */
  calculatePosition(fields, positionConfig = {}, pagination = null) {
    const { mode = 'append', reference, page } = positionConfig;
    
    // Handle page-specific positioning for multi-page forms
    if (pagination && page) {
      return this.calculatePagePosition(fields, page, mode, reference, pagination);
    }
    
    // Handle non-paged positioning
    switch (mode) {
      case 'append':
        // Add to end of form
        return fields.length;
        
      case 'prepend':
        // Add to beginning of form
        return 0;
        
      case 'after':
        // Add after specific field
        return this.positionAfterField(fields, reference);
        
      case 'before':
        // Add before specific field
        return this.positionBeforeField(fields, reference);
        
      case 'index':
        // Insert at specific index
        return this.positionAtIndex(fields, reference);
        
      default:
        // Default to append
        return fields.length;
    }
  }
  
  /**
   * Calculate position for page-specific insertion
   */
  calculatePagePosition(fields, pageNumber, mode, reference, pagination) {
    // Get page boundaries
    const pageBoundaries = this.getPageBoundaries(fields);
    
    // Validate page number
    const totalPages = pageBoundaries.length + 1;
    if (pageNumber < 1 || pageNumber > totalPages) {
      logger.warn(`Page ${pageNumber} out of range (1-${totalPages}), defaulting to last page`);
      return fields.length;
    }
    
    // Get fields for specific page
    const pageFields = this.getFieldsForPage(fields, pageNumber, pageBoundaries);
    
    if (pageFields.length === 0) {
      // Empty page - find appropriate position
      if (pageNumber === 1) {
        // First page - add at beginning
        return 0;
      } else if (pageNumber <= pageBoundaries.length) {
        // Middle page - add after previous page break
        const pageBreakIndex = fields.indexOf(pageBoundaries[pageNumber - 2]);
        return pageBreakIndex + 1;
      } else {
        // Last page - add at end
        return fields.length;
      }
    }
    
    switch (mode) {
      case 'append':
        // Add to end of specified page
        const lastFieldOnPage = pageFields[pageFields.length - 1];
        const lastFieldIndex = fields.indexOf(lastFieldOnPage);
        
        // Check if next field is a page break
        if (lastFieldIndex + 1 < fields.length && fields[lastFieldIndex + 1].type === 'page') {
          // Insert before the page break
          return lastFieldIndex + 1;
        }
        // Insert after last field on page
        return lastFieldIndex + 1;
        
      case 'prepend':
        // Add to beginning of specified page
        const firstFieldOnPage = pageFields[0];
        return fields.indexOf(firstFieldOnPage);
        
      case 'after':
        // Add after specific field on this page
        const afterField = pageFields.find(f => f.id == reference);
        if (afterField) {
          return fields.indexOf(afterField) + 1;
        }
        // Field not found on page, append to page
        return this.calculatePagePosition(fields, pageNumber, 'append', null, pagination);
        
      case 'before':
        // Add before specific field on this page
        const beforeField = pageFields.find(f => f.id == reference);
        if (beforeField) {
          return fields.indexOf(beforeField);
        }
        // Field not found on page, prepend to page
        return this.calculatePagePosition(fields, pageNumber, 'prepend', null, pagination);
        
      default:
        // Default to append on page
        return this.calculatePagePosition(fields, pageNumber, 'append', null, pagination);
    }
  }
  
  /**
   * Get all page break fields (boundaries between pages)
   */
  getPageBoundaries(fields) {
    return fields.filter(field => field.type === 'page');
  }
  
  /**
   * Get all fields that belong to a specific page
   */
  getFieldsForPage(fields, pageNumber, pageBoundaries = null) {
    if (!pageBoundaries) {
      pageBoundaries = this.getPageBoundaries(fields);
    }
    
    const pageFields = [];
    let currentPage = 1;
    
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      
      // Skip page break fields themselves
      if (field.type === 'page') {
        currentPage++;
        continue;
      }
      
      // Add field if it's on the requested page
      if (currentPage === pageNumber) {
        pageFields.push(field);
      }
      
      // Stop if we've passed the requested page
      if (currentPage > pageNumber) {
        break;
      }
    }
    
    return pageFields;
  }
  
  /**
   * Determine which page a field belongs to
   */
  getFieldPage(field, allFields, _pagination = null) {
    const fieldIndex = allFields.indexOf(field);
    if (fieldIndex === -1) return null;
    
    let currentPage = 1;
    
    for (let i = 0; i < fieldIndex; i++) {
      if (allFields[i].type === 'page') {
        currentPage++;
      }
    }
    
    return currentPage;
  }
  
  /**
   * Position field after a reference field
   */
  positionAfterField(fields, referenceFieldId) {
    if (!referenceFieldId) {
      // No reference, append to end
      return fields.length;
    }
    
    const afterIndex = fields.findIndex(f => f.id == referenceFieldId);
    
    if (afterIndex >= 0) {
      // Found reference field, insert after it
      return afterIndex + 1;
    } else {
      // Reference field not found, append to end
      logger.warn(`Reference field ${referenceFieldId} not found, appending to end`);
      return fields.length;
    }
  }
  
  /**
   * Position field before a reference field
   */
  positionBeforeField(fields, referenceFieldId) {
    if (!referenceFieldId) {
      // No reference, prepend to beginning
      return 0;
    }
    
    const beforeIndex = fields.findIndex(f => f.id == referenceFieldId);
    
    if (beforeIndex >= 0) {
      // Found reference field, insert before it
      return beforeIndex;
    } else {
      // Reference field not found, append to end
      logger.warn(`Reference field ${referenceFieldId} not found, appending to end`);
      return fields.length;
    }
  }
  
  /**
   * Position field at specific index
   */
  positionAtIndex(fields, index) {
    if (typeof index !== 'number') {
      // Invalid index, append to end
      return fields.length;
    }
    
    // Clamp index to valid range
    if (index < 0) {
      return 0;
    } else if (index > fields.length) {
      return fields.length;
    } else {
      return index;
    }
  }
  
  /**
   * Validate positioning configuration
   */
  validatePositionConfig(positionConfig, fields) {
    const errors = [];
    const warnings = [];
    
    if (!positionConfig) {
      return { valid: true, errors, warnings };
    }
    
    const { mode, reference, page } = positionConfig;
    
    // Validate mode
    const validModes = ['append', 'prepend', 'after', 'before', 'index'];
    if (mode && !validModes.includes(mode)) {
      errors.push(`Invalid position mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
    }
    
    // Validate reference for modes that require it
    if ((mode === 'after' || mode === 'before') && !reference) {
      warnings.push(`Position mode '${mode}' specified without reference field ID`);
    }
    
    // Validate reference field exists
    if (reference && (mode === 'after' || mode === 'before')) {
      const refField = fields.find(f => f.id == reference);
      if (!refField) {
        warnings.push(`Reference field ${reference} not found in form`);
      }
    }
    
    // Validate page number
    if (page !== undefined) {
      if (typeof page !== 'number' || page < 1) {
        errors.push(`Invalid page number: ${page}. Must be a positive integer`);
      }
      
      // Check if page is within range
      const pageBreaks = this.getPageBoundaries(fields);
      const totalPages = pageBreaks.length + 1;
      if (page > totalPages) {
        warnings.push(`Page ${page} exceeds total pages (${totalPages})`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
  
  /**
   * Get position summary for logging/debugging
   */
  getPositionSummary(fields, position, field) {
    const pageBreaks = this.getPageBoundaries(fields);
    const totalPages = pageBreaks.length + 1;
    const fieldPage = this.getFieldPage(field, fields);
    
    return {
      totalFields: fields.length,
      totalPages,
      insertedAt: position,
      onPage: fieldPage,
      afterField: position > 0 ? fields[position - 1]?.id : null,
      beforeField: position < fields.length ? fields[position]?.id : null
    };
  }
}