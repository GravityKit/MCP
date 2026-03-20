/**
 * Gravity Forms Field Registry
 * 
 * Complete field type definitions for validation and processing.
 * This registry contains metadata for all Gravity Forms field types
 * to ensure 100% valid structure for forms, entries, and JSON data.
 */

/**
 * Field type metadata and validation rules
 * Each field type includes:
 * - Basic metadata (label, category, support flags)
 * - Storage pattern (how data is stored in entries)
 * - Validation rules
 * - Field variants (different configurations)
 */
export const fieldRegistry = {
  // Standard Fields
  text: {
    type: 'text',
    label: 'Single Line Text',
    category: 'standard',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      default: { label: 'Default Text', settings: {} },
      password: { label: 'Password Input', settings: { enablePasswordInput: true } }
    },
    validation: {
      maxLength: 255,
      patterns: []
    }
  },

  textarea: {
    type: 'textarea',
    label: 'Paragraph Text',
    category: 'standard',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      default: { label: 'Default', settings: {} },
      richtext: { label: 'Rich Text Editor', settings: { useRichTextEditor: true } }
    }
  },

  email: {
    type: 'email',
    label: 'Email',
    category: 'standard',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    validation: {
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      message: 'Please enter a valid email address'
    }
  },

  number: {
    type: 'number',
    label: 'Number',
    category: 'standard',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'number',
      format: 'single'
    },
    variants: {
      default: { label: 'Default', settings: {} },
      currency: { label: 'Currency', settings: { numberFormat: 'currency' } },
      decimal: { label: 'Decimal', settings: { numberFormat: 'decimal' } }
    },
    validation: {
      min: null,
      max: null,
      step: null
    }
  },

  phone: {
    type: 'phone',
    label: 'Phone',
    category: 'standard',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      standard: { label: 'Standard', settings: { phoneFormat: 'standard' } },
      international: { label: 'International', settings: { phoneFormat: 'international' } }
    }
  },

  website: {
    type: 'website',
    label: 'Website',
    category: 'standard',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    validation: {
      pattern: /^https?:\/\/.+/,
      message: 'Please enter a valid URL'
    }
  },

  // Choice Fields
  select: {
    type: 'select',
    label: 'Dropdown',
    category: 'choice',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      default: { label: 'Default', settings: {} },
      enhanced: { label: 'Enhanced UI', settings: { enableEnhancedUI: true } }
    },
    hasChoices: true
  },

  radio: {
    type: 'radio',
    label: 'Radio Buttons',
    category: 'choice',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      default: { label: 'Default', settings: {} },
      otherChoice: { label: 'With Other Option', settings: { enableOtherChoice: true } }
    },
    hasChoices: true
  },

  checkbox: {
    type: 'checkbox',
    label: 'Checkboxes',
    category: 'choice',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'array',
      format: 'json',
      itemFormat: 'input_{fieldId}_{index}'
    },
    hasChoices: true,
    isArray: true
  },

  multiselect: {
    type: 'multiselect',
    label: 'Multi Select',
    category: 'choice',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'array',
      format: 'json'
    },
    variants: {
      default: { label: 'Default', settings: {} },
      enhanced: { label: 'Enhanced UI', settings: { enableEnhancedUI: true } }
    },
    hasChoices: true,
    isArray: true
  },

  // Advanced Fields
  name: {
    type: 'name',
    label: 'Name',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'compound',
      format: 'dotNotation',
      subInputs: {
        '2': 'prefix',
        '3': 'first',
        '4': 'middle',
        '6': 'last',
        '8': 'suffix'
      }
    },
    isCompound: true
  },

  address: {
    type: 'address',
    label: 'Address',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'compound',
      format: 'dotNotation',
      subInputs: {
        '1': 'street',
        '2': 'street2',
        '3': 'city',
        '4': 'state',
        '5': 'zip',
        '6': 'country'
      }
    },
    isCompound: true,
    variants: {
      us: { label: 'US Address', settings: { addressType: 'us' } },
      canadian: { label: 'Canadian Address', settings: { addressType: 'canadian' } },
      international: { label: 'International', settings: { addressType: 'international' } }
    }
  },

  date: {
    type: 'date',
    label: 'Date',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      datefield: { label: 'Date Field', settings: { dateType: 'datefield' } },
      datepicker: { label: 'Date Picker', settings: { dateType: 'datepicker' } },
      datedropdown: { label: 'Date Dropdown', settings: { dateType: 'datedropdown' } }
    }
  },

  time: {
    type: 'time',
    label: 'Time',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      'hour12': { label: '12 Hour', settings: { timeFormat: '12' } },
      'hour24': { label: '24 Hour', settings: { timeFormat: '24' } }
    }
  },

  fileupload: {
    type: 'fileupload',
    label: 'File Upload',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'mixed',
      format: 'conditional',
      condition: 'multipleFiles',
      singleFormat: 'string',
      multipleFormat: 'json'
    },
    variants: {
      single: { label: 'Single File', settings: { multipleFiles: false } },
      multiple: { label: 'Multiple Files', settings: { multipleFiles: true } }
    }
  },

  list: {
    type: 'list',
    label: 'List',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'array',
      format: 'serialized'
    },
    isArray: true,
    variants: {
      single: { label: 'Single Column', settings: { enableColumns: false } },
      multi: { label: 'Multiple Columns', settings: { enableColumns: true } }
    }
  },

  hidden: {
    type: 'hidden',
    label: 'Hidden',
    category: 'standard',
    supportsRequired: false,
    supportsConditionalLogic: false,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  // HTML Fields
  html: {
    type: 'html',
    label: 'HTML',
    category: 'standard',
    supportsRequired: false,
    supportsConditionalLogic: true,
    storage: {
      type: 'none',
      format: 'none'
    },
    storesData: false
  },

  section: {
    type: 'section',
    label: 'Section Break',
    category: 'standard',
    supportsRequired: false,
    supportsConditionalLogic: true,
    storage: {
      type: 'none',
      format: 'none'
    },
    storesData: false
  },

  page: {
    type: 'page',
    label: 'Page Break',
    category: 'standard',
    supportsRequired: false,
    supportsConditionalLogic: true,
    storage: {
      type: 'none',
      format: 'none'
    },
    storesData: false,
    isPageBreak: true
  },

  // Post Fields
  post_title: {
    type: 'post_title',
    label: 'Post Title',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  post_body: {
    type: 'post_body',
    label: 'Post Body',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  post_excerpt: {
    type: 'post_excerpt',
    label: 'Post Excerpt',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  post_category: {
    type: 'post_category',
    label: 'Post Category',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      dropdown: { label: 'Dropdown', settings: { displayAllCategories: false } },
      checkboxes: { label: 'Checkboxes', settings: { displayAllCategories: true } }
    }
  },

  post_tags: {
    type: 'post_tags',
    label: 'Post Tags',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  post_image: {
    type: 'post_image',
    label: 'Post Image',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  post_custom_field: {
    type: 'post_custom_field',
    label: 'Post Custom Field',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    }
  },

  // Pricing Fields
  product: {
    type: 'product',
    label: 'Product',
    category: 'pricing',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      singleproduct: { label: 'Single Product', settings: { inputType: 'singleproduct' } },
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' } },
      radio: { label: 'Radio Buttons', settings: { inputType: 'radio' } },
      calculation: { label: 'Calculation', settings: { inputType: 'calculation' } },
      price: { label: 'User Defined Price', settings: { inputType: 'price' } },
      hiddenproduct: { label: 'Hidden', settings: { inputType: 'hiddenproduct' } }
    }
  },

  quantity: {
    type: 'quantity',
    label: 'Quantity',
    category: 'pricing',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'number',
      format: 'single'
    }
  },

  option: {
    type: 'option',
    label: 'Option',
    category: 'pricing',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' } },
      checkboxes: { label: 'Checkboxes', settings: { inputType: 'checkbox' } },
      radio: { label: 'Radio Buttons', settings: { inputType: 'radio' } }
    }
  },

  shipping: {
    type: 'shipping',
    label: 'Shipping',
    category: 'pricing',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    variants: {
      singleshipping: { label: 'Single Method', settings: { inputType: 'singleshipping' } },
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' } },
      radio: { label: 'Radio Buttons', settings: { inputType: 'radio' } }
    }
  },

  total: {
    type: 'total',
    label: 'Total',
    category: 'pricing',
    supportsRequired: false,
    supportsConditionalLogic: false,
    storage: {
      type: 'string',
      format: 'single'
    },
    isCalculated: true
  },

  // Special Fields
  creditcard: {
    type: 'creditcard',
    label: 'Credit Card',
    category: 'pricing',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'compound',
      format: 'dotNotation',
      subInputs: {
        '1': 'card_number',
        '2': 'expiration_date',
        '3': 'security_code',
        '4': 'card_name',
        '5': 'card_type'
      }
    },
    isCompound: true,
    isSensitive: true
  },

  consent: {
    type: 'consent',
    label: 'Consent',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'compound',
      format: 'dotNotation',
      subInputs: {
        '1': 'checked',
        '2': 'text'
      }
    },
    isCompound: true
  },

  signature: {
    type: 'signature',
    label: 'Signature',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'base64'
    }
  },

  captcha: {
    type: 'captcha',
    label: 'CAPTCHA',
    category: 'advanced',
    supportsRequired: false,
    supportsConditionalLogic: false,
    storage: {
      type: 'none',
      format: 'none'
    },
    storesData: false,
    isValidation: true
  },

  // Quiz Fields
  quiz: {
    type: 'quiz',
    label: 'Quiz',
    category: 'quiz',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    hasChoices: true,
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' } },
      radio: { label: 'Radio', settings: { inputType: 'radio' } },
      checkbox: { label: 'Checkbox', settings: { inputType: 'checkbox' } }
    }
  },

  // Poll Fields  
  poll: {
    type: 'poll',
    label: 'Poll',
    category: 'poll',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    hasChoices: true,
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' } },
      radio: { label: 'Radio', settings: { inputType: 'radio' } },
      checkbox: { label: 'Checkbox', settings: { inputType: 'checkbox' } }
    }
  },

  // Survey Fields
  survey_likert: {
    type: 'survey_likert',
    label: 'Likert',
    category: 'survey',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'compound',
      format: 'dotNotation'
    },
    hasChoices: true,
    isCompound: true
  },

  survey_rank: {
    type: 'survey_rank',
    label: 'Rank',
    category: 'survey',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    hasChoices: true
  },

  survey_rating: {
    type: 'survey_rating',
    label: 'Rating',
    category: 'survey',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    hasChoices: true
  },

  // Nested Form Fields
  form: {
    type: 'form',
    label: 'Nested Form',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'array',
      format: 'json'
    },
    isNested: true,
    isArray: true
  },

  repeater: {
    type: 'repeater',
    label: 'Repeater',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'array',
      format: 'json'
    },
    isRepeater: true,
    isArray: true
  },

  // Chained Select
  chainedselect: {
    type: 'chainedselect',
    label: 'Chained Select',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'single'
    },
    hasChoices: true,
    isChained: true
  }
};

/**
 * Helper function to get field definition
 */
export function getFieldDefinition(fieldType) {
  return fieldRegistry[fieldType] || null;
}

/**
 * Helper function to check if field is compound
 */
export function isCompoundField(fieldType) {
  const field = fieldRegistry[fieldType];
  return field ? field.isCompound === true : false;
}

/**
 * Helper function to check if field stores array data
 */
export function isArrayField(fieldType) {
  const field = fieldRegistry[fieldType];
  return field ? field.isArray === true : false;
}

/**
 * Helper function to check if field stores data
 */
export function fieldStoresData(fieldType) {
  const field = fieldRegistry[fieldType];
  return field ? field.storesData !== false : true;
}

/**
 * Helper function to get storage format
 */
export function getStorageFormat(fieldType) {
  const field = fieldRegistry[fieldType];
  return field && field.storage ? field.storage.format : 'single';
}

/**
 * Helper function to detect field variant
 */
export function detectFieldVariant(field) {
  const definition = fieldRegistry[field.type];
  if (!definition || !definition.variants) {
    return 'default';
  }

  // Check each variant's settings
  for (const [variantId, variant] of Object.entries(definition.variants)) {
    if (variantId === 'default') continue;
    
    const isMatch = Object.entries(variant.settings || {}).every(([key, value]) => {
      return field[key] === value;
    });

    if (isMatch) {
      return variantId;
    }
  }

  return 'default';
}

/**
 * Validate field configuration
 */
export function validateFieldConfig(field) {
  const definition = fieldRegistry[field.type];
  
  if (!definition) {
    return {
      isValid: false,
      error: `Unknown field type: ${field.type}`
    };
  }

  // Check required properties
  if (!field.id) {
    return {
      isValid: false,
      error: 'Field must have an id'
    };
  }

  if (!field.label && field.type !== 'hidden') {
    return {
      isValid: false,
      error: 'Field must have a label'
    };
  }

  // Validate choices if required
  if (definition.hasChoices && (!field.choices || !Array.isArray(field.choices))) {
    return {
      isValid: false,
      error: `Field type ${field.type} requires choices array`
    };
  }

  return { isValid: true };
}

/**
 * Get all field types by category
 */
export function getFieldsByCategory() {
  const categories = {};
  
  for (const [type, definition] of Object.entries(fieldRegistry)) {
    const category = definition.category || 'other';
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push({
      type,
      label: definition.label
    });
  }
  
  return categories;
}

/**
 * Get compound field sub-inputs
 */
export function getCompoundFieldInputs(fieldType) {
  const field = fieldRegistry[fieldType];

  if (!field || !field.isCompound || !field.storage.subInputs) {
    return null;
  }

  return field.storage.subInputs;
}

/**
 * Generate inputs array for compound fields (address, name, creditcard, etc.)
 * This ensures compound fields have the required sub-input definitions.
 *
 * @param {object} field - The field object with id, type, and optional variant settings.
 *
 * @returns {array|null} Array of input definitions or null if not a compound field.
 */
export function generateCompoundInputs(field) {
  const fieldDef = fieldRegistry[field.type];

  if (!fieldDef || !fieldDef.isCompound) {
    return null;
  }

  const baseId = field.id;
  const subInputs = [];

  // Address field sub-inputs.
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

  // Name field sub-inputs.
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

  // Credit card field sub-inputs.
  else if (field.type === 'creditcard') {
    subInputs.push(
      { id: `${baseId}.1`, label: 'Card Number', name: '' },
      { id: `${baseId}.2`, label: 'Expiration Date', name: '' },
      { id: `${baseId}.3`, label: 'Security Code', name: '' },
      { id: `${baseId}.4`, label: 'Cardholder Name', name: '' },
      { id: `${baseId}.5`, label: 'Card Type', name: '' }
    );
  }

  // Consent field sub-inputs.
  else if (field.type === 'consent') {
    subInputs.push(
      { id: `${baseId}.1`, label: 'Consent', name: '' },
      { id: `${baseId}.2`, label: 'Text', name: '' },
      { id: `${baseId}.3`, label: 'Description', name: '' }
    );
  }

  return subInputs.length > 0 ? subInputs : null;
}

export default fieldRegistry;
