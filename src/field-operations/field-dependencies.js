/**
 * Dependency Tracker - Scans and analyzes field dependencies
 * Detects usage in conditional logic, calculations, merge tags, and dynamic population
 */

export class DependencyTracker {
  /**
   * Scan form for all dependencies of a specific field
   * @param {object} form - Complete form object
   * @param {number} fieldId - Field ID to check dependencies for
   * @returns {object} Dependencies categorized by type
   */
  scanFormDependencies(form, fieldId) {
    const dependencies = {
      conditionalLogic: [],
      calculations: [],
      mergeTags: [],
      dynamicPopulation: []
    };

    if (!form || typeof form !== 'object') {
      return dependencies;
    }

    // 1. Check conditional logic dependencies in all fields
    this.scanConditionalLogic(form, fieldId, dependencies);
    
    // 2. Check calculation formula dependencies
    this.scanCalculations(form, fieldId, dependencies);
    
    // 3. Check merge tags in notifications and confirmations
    this.scanMergeTags(form, fieldId, dependencies);
    
    // 4. Check dynamic population references
    this.scanDynamicPopulation(form, fieldId, dependencies);

    return dependencies;
  }

  /**
   * Scan conditional logic rules for field references
   */
  scanConditionalLogic(form, fieldId, dependencies) {
    form.fields?.forEach(field => {
      if (field.conditionalLogic?.enabled && field.conditionalLogic?.rules) {
        const affectedRules = field.conditionalLogic.rules.filter(
          rule => rule.fieldId == fieldId
        );
        
        if (affectedRules.length > 0) {
          dependencies.conditionalLogic.push({
            field_id: field.id,
            field_label: field.label || `Field ${field.id}`,
            field_type: field.type,
            rule_count: affectedRules.length,
            rules: affectedRules.map(rule => ({
              operator: rule.operator,
              value: rule.value
            }))
          });
        }
      }
    });
  }

  /**
   * Scan calculation formulas for field references
   */
  scanCalculations(form, fieldId, dependencies) {
    form.fields?.forEach(field => {
      if (field.enableCalculation && field.calculationFormula) {
        // Check for merge tags with this field ID
        // Patterns: {fieldLabel:fieldId}, {:fieldId}, {fieldId}
        const patterns = [
          new RegExp(`\\{[^}]*:${fieldId}\\}`, 'g'),          // {Label:ID}
          new RegExp(`\\{:${fieldId}\\}`, 'g'),               // {:ID}
          new RegExp(`\\{${fieldId}\\}`, 'g'),                // {ID}
          new RegExp(`\\{[^}]*:${fieldId}\\.[0-9]+\\}`, 'g'), // {Label:ID.subId}
        ];
        
        let hasMatch = false;
        let matches = [];
        
        patterns.forEach(pattern => {
          const formulaMatches = field.calculationFormula.match(pattern);
          if (formulaMatches) {
            hasMatch = true;
            matches = matches.concat(formulaMatches);
          }
        });
        
        if (hasMatch) {
          dependencies.calculations.push({
            field_id: field.id,
            field_label: field.label || `Field ${field.id}`,
            field_type: field.type,
            formula: field.calculationFormula,
            matches: [...new Set(matches)] // Unique matches
          });
        }
      }
    });
  }

  /**
   * Scan merge tags in notifications and confirmations
   */
  scanMergeTags(form, fieldId, dependencies) {
    // Patterns for merge tag detection
    const mergeTagPatterns = [
      new RegExp(`\\{[^}]*:${fieldId}\\}`, 'g'),          // {Label:ID}
      new RegExp(`\\{:${fieldId}\\}`, 'g'),               // {:ID}
      new RegExp(`\\{${fieldId}\\}`, 'g'),                // {ID}
      new RegExp(`\\{[^}]*:${fieldId}\\.[0-9]+\\}`, 'g'), // {Label:ID.subId}
      new RegExp(`\\{[^}]*:${fieldId}:[^}]*\\}`, 'g'),   // {Label:ID:modifier}
    ];
    
    // Check notifications
    if (form.notifications) {
      Object.entries(form.notifications).forEach(([notificationId, notification]) => {
        const fieldsToCheck = [
          'subject',
          'message', 
          'from',
          'fromName',
          'replyTo',
          'to',
          'cc',
          'bcc'
        ];
        
        fieldsToCheck.forEach(fieldName => {
          if (notification[fieldName]) {
            const content = String(notification[fieldName]);
            let hasMatch = false;
            let matches = [];
            
            mergeTagPatterns.forEach(pattern => {
              const fieldMatches = content.match(pattern);
              if (fieldMatches) {
                hasMatch = true;
                matches = matches.concat(fieldMatches);
              }
            });
            
            if (hasMatch) {
              dependencies.mergeTags.push({
                location: 'notification',
                id: notificationId,
                name: notification.name || 'Unnamed Notification',
                field: fieldName,
                context: `${notification.name} - ${fieldName}`,
                matches: [...new Set(matches)]
              });
            }
          }
        });
      });
    }
    
    // Check confirmations
    if (form.confirmations) {
      Object.entries(form.confirmations).forEach(([confirmationId, confirmation]) => {
        const fieldsToCheck = ['message', 'url', 'pageId', 'queryString'];
        
        fieldsToCheck.forEach(fieldName => {
          if (confirmation[fieldName]) {
            const content = String(confirmation[fieldName]);
            let hasMatch = false;
            let matches = [];
            
            mergeTagPatterns.forEach(pattern => {
              const fieldMatches = content.match(pattern);
              if (fieldMatches) {
                hasMatch = true;
                matches = matches.concat(fieldMatches);
              }
            });
            
            if (hasMatch) {
              dependencies.mergeTags.push({
                location: 'confirmation',
                id: confirmationId,
                name: confirmation.name || 'Default Confirmation',
                type: confirmation.type,
                field: fieldName,
                context: `${confirmation.name} - ${fieldName}`,
                matches: [...new Set(matches)]
              });
            }
          }
        });
      });
    }
    
    // Check field default values and descriptions for merge tags
    form.fields?.forEach(field => {
      const fieldsToCheck = ['defaultValue', 'description', 'content'];
      
      fieldsToCheck.forEach(fieldName => {
        if (field[fieldName]) {
          const content = String(field[fieldName]);
          let hasMatch = false;
          let matches = [];
          
          mergeTagPatterns.forEach(pattern => {
            const fieldMatches = content.match(pattern);
            if (fieldMatches) {
              hasMatch = true;
              matches = matches.concat(fieldMatches);
            }
          });
          
          if (hasMatch) {
            dependencies.mergeTags.push({
              location: 'field',
              field_id: field.id,
              field_label: field.label || `Field ${field.id}`,
              property: fieldName,
              context: `Field ${field.id} - ${fieldName}`,
              matches: [...new Set(matches)]
            });
          }
        }
      });
    });
  }

  /**
   * Scan for dynamic population dependencies
   */
  scanDynamicPopulation(form, fieldId, dependencies) {
    // Check if the target field has dynamic population enabled
    const targetField = form.fields?.find(f => f.id == fieldId);
    
    if (targetField?.allowsPrepopulate && targetField?.inputName) {
      // Look for other fields that might reference this parameter
      form.fields?.forEach(field => {
        // Check if any field's default value references this parameter
        if (field.defaultValue) {
          const paramPattern = new RegExp(`{${targetField.inputName}}`, 'g');
          if (paramPattern.test(field.defaultValue)) {
            dependencies.dynamicPopulation.push({
              field_id: field.id,
              field_label: field.label || `Field ${field.id}`,
              parameter: targetField.inputName,
              usage: 'default_value'
            });
          }
        }
      });
      
      // Note that this field accepts dynamic population
      dependencies.dynamicPopulation.push({
        field_id: targetField.id,
        field_label: targetField.label || `Field ${targetField.id}`,
        parameter: targetField.inputName,
        usage: 'accepts_population'
      });
    }
  }

  /**
   * Check if dependencies would break form functionality
   */
  hasBreakingDependencies(dependencies) {
    if (!dependencies || typeof dependencies !== 'object') {
      return false;
    }
    return (
      (dependencies.conditionalLogic?.length > 0) ||
      (dependencies.calculations?.length > 0) ||
      (dependencies.mergeTags?.length > 0)
    );
  }

  /**
   * Generate human-readable dependency summary
   */
  generateDependencySummary(dependencies) {
    const summary = [];
    
    if (dependencies.conditionalLogic.length > 0) {
      summary.push(`${dependencies.conditionalLogic.length} conditional logic rule(s)`);
    }
    
    if (dependencies.calculations.length > 0) {
      summary.push(`${dependencies.calculations.length} calculation formula(s)`);
    }
    
    if (dependencies.mergeTags.length > 0) {
      summary.push(`${dependencies.mergeTags.length} merge tag reference(s)`);
    }
    
    if (dependencies.dynamicPopulation.length > 0) {
      summary.push(`${dependencies.dynamicPopulation.length} dynamic population reference(s)`);
    }
    
    return summary.length > 0 ? 
      `Field has dependencies: ${summary.join(', ')}` : 
      'No dependencies found';
  }
}