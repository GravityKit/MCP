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

  password: {
    // GF registers 'password' as its OWN field type (GF_Field_Password), not a
    // text variant. It is single-id — get_entry_inputs() returns null, so no
    // dot-notation sub-inputs. CRITICALLY, GF does NOT persist passwords: the
    // value is stashed/hydrated into the runtime $entry only during submission;
    // the DB entry value is an EMPTY STRING (''). (class-gf-field-password.php;
    // tests/unit-tests/gf-field/test-type-password.php::test_not_saving_passwords
    // asserts $entry['1'] === '').
    type: 'password',
    label: 'Password',
    category: 'advanced',
    supportsRequired: true,
    supportsConditionalLogic: false,
    storage: {
      type: 'string',
      format: 'single'
    },
    storesData: false,
    isSensitive: true
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
      // GF stores number values as a TEXT string in the entry; numberFormat
      // (decimal_dot/decimal_comma/currency) governs display/validation only.
      // (class-gf-field-number.php get_value_submission → string.)
      type: 'string',
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
      type: 'compound',
      format: 'dotNotation',
      // Each choice maps to a sub-input: fieldId.1, fieldId.2, etc.
      // Checked = choice value, unchecked = empty string.
      // Sub-input IDs have gaps when choices are deleted (never reused).
    },
    hasChoices: true,
    isCompound: true,
    isArray: true  // FieldAwareValidator uses this to extract/process multi-value data
  },

  multiselect: {
    type: 'multiselect',
    label: 'Multi Select',
    category: 'choice',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'string',
      format: 'commaSeparated',
      // GFAPI stores as JSON string in DB; REST API v2 accepts/returns
      // comma-separated values. Values containing commas are a known
      // GF REST API limitation — they get split incorrectly.
    },
    variants: {
      default: { label: 'Default', settings: {} },
      enhanced: { label: 'Enhanced UI', settings: { enableEnhancedUI: true } }
    },
    hasChoices: true,
    isMultiValue: true,
    isArray: true  // FieldAwareValidator uses this to extract/process multi-value data
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
      // GF stores a JSON array when EITHER multipleFiles is on OR the field's
      // storageType === 'json' (a single file set to JSON storage is also
      // JSON-encoded, e.g. ["https://.../file.pdf"]).
      // (class-gf-field-fileupload.php to_string: storageType==='json' ||
      // multipleFiles || is_array($value) → json_encode.)
      condition: "storageType === 'json' || multipleFiles",
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
      format: 'serialized',
      // GFAPI stores as PHP serialized string in DB.
      // REST API v2 transparently converts to/from JSON arrays.
      // Single-col: array of strings ["a","b","c"]
      // Multi-col: array of objects [{"Col1":"val","Col2":"val"},...]
    },
    isArray: true,
    variants: {
      single: { label: 'Single Column', settings: { enableColumns: false }, storage: { items: 'string' } },
      multi: { label: 'Multiple Columns', settings: { enableColumns: true }, storage: { items: 'object' } }
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

  post_content: {
    // The GF field type is 'post_content' (GF_Field_Post_Content, $type =
    // 'post_content'). Storage is a plain string.
    type: 'post_content',
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
      type: 'varies',
      format: 'inputType-dependent',
      // select/radio: single string "Name:ID"
      // checkbox: dot-notation sub-inputs "Name:ID" per sub-input
      //   NOTE: displayAllCategories=true generates inputs/choices dynamically
      //   at render time — they are NOT stored in form meta. REST API returns
      //   no inputs/choices for these fields.
      // multiselect: comma-separated string of "Name:ID" values
    },
    hasChoices: true,
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' } },
      radio: { label: 'Radio', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' } },
      checkboxes: { label: 'Checkboxes', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' } },
      multiselect: { label: 'Multi Select', settings: { inputType: 'multiselect' }, storage: { type: 'string', format: 'commaSeparated' } }
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
      // GF stores ONE composite string under the field id, five segments
      // joined by "|:|": url|:|title|:|caption|:|description|:|alt. NOT a bare
      // URL and NOT dot-notation sub-inputs. (class-gf-field-post-image.php
      // get_value_save_entry.) Trailing segments may be empty (url-only is OK).
      type: 'string',
      format: 'composite',
      delimiter: '|:|',
      segments: ['url', 'title', 'caption', 'description', 'alt']
    }
  },

  post_custom_field: {
    type: 'post_custom_field',
    label: 'Post Custom Field',
    category: 'post',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'varies',
      format: 'inputType-dependent',
      // Inherits storage from its inputType: text, textarea, select, radio,
      // checkbox, multiselect, hidden, date, time, phone, number, website,
      // email, fileupload, list. Checkbox → dot-notation, multiselect → comma-separated.
    },
    variants: {
      text: { label: 'Text', settings: { inputType: 'text' }, storage: { type: 'string', format: 'single' } },
      textarea: { label: 'Textarea', settings: { inputType: 'textarea' }, storage: { type: 'string', format: 'single' } },
      select: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' } },
      radio: { label: 'Radio', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' } },
      checkbox: { label: 'Checkbox', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' } },
      multiselect: { label: 'Multi Select', settings: { inputType: 'multiselect' }, storage: { type: 'string', format: 'commaSeparated' } },
      hidden: { label: 'Hidden', settings: { inputType: 'hidden' }, storage: { type: 'string', format: 'single' } }
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
      type: 'varies',
      format: 'inputType-dependent',
      // singleproduct/calculation/hiddenproduct: compound dot-notation
      //   (.1=name, .2=price, .3=quantity) — has inputs, NO choices
      // select/radio: single "value|price" string — has choices, NO inputs
      // checkbox: dot-notation sub-inputs "value|price" — has inputs + choices
      // price (User Defined Price): single money/number string — no inputs,
      //   no choices (class-gf-field-price.php renders one input_{id}, no .1/.2/.3)
    },
    hasChoices: true,
    variants: {
      singleproduct: { label: 'Single Product', settings: { inputType: 'singleproduct' }, storage: { type: 'compound', format: 'dotNotation' } },
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' } },
      radio: { label: 'Radio Buttons', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' } },
      checkbox: { label: 'Checkboxes', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' } },
      calculation: { label: 'Calculation', settings: { inputType: 'calculation' }, storage: { type: 'compound', format: 'dotNotation' } },
      price: { label: 'User Defined Price', settings: { inputType: 'price' }, storage: { type: 'string', format: 'single' } },
      hiddenproduct: { label: 'Hidden', settings: { inputType: 'hiddenproduct' }, storage: { type: 'compound', format: 'dotNotation' } }
    }
  },

  quantity: {
    type: 'quantity',
    label: 'Quantity',
    category: 'pricing',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      // Like number, GF stores the quantity as a TEXT string in the entry.
      type: 'string',
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
      type: 'varies',
      format: 'inputType-dependent',
      // select/radio: single "value|price" string
      // checkbox: dot-notation sub-inputs "value|price"
    },
    hasChoices: true,
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' } },
      checkboxes: { label: 'Checkboxes', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' } },
      radio: { label: 'Radio Buttons', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' } }
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
      // GF persists ONLY two sub-inputs to the entry: .1 = the card number
      // MASKED to last-4 (e.g. "XXXXXXXXXXXX1111") and .4 = the card TYPE name
      // (e.g. "Visa"). The expiration (.2), security code (.3) and cardholder
      // name (.5) are NEVER stored — the security code is never persisted.
      // (class-gf-field-creditcard.php get_entry_inputs + get_value_save_entry.)
      subInputs: {
        '1': 'card_number_masked',
        '4': 'card_type'
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
        '2': 'text',
        '3': 'revision'
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
      // The Signature add-on saves the drawn image to disk and stores its
      // FILENAME (e.g. "<hash>.png") in the entry; the public URL is derived
      // from the filename at display time (get_signature_url()).
      // (class-gf-field-signature.php get_value_save_entry → maybe_save_signature.)
      type: 'string',
      format: 'filename'
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
      type: 'varies',
      format: 'inputType-dependent',
      // select/radio: single "gquizNN" string
      // checkbox: dot-notation sub-inputs with "gquizNN" values
    },
    hasChoices: true,
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' } },
      radio: { label: 'Radio', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' } },
      checkbox: { label: 'Checkbox', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' } }
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
      type: 'varies',
      format: 'inputType-dependent',
      // select/radio: single "gpollN" string
      // checkbox: dot-notation sub-inputs with "gpollN" values
    },
    hasChoices: true,
    variants: {
      dropdown: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' } },
      radio: { label: 'Radio', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' } },
      checkbox: { label: 'Checkbox', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' } }
    }
  },

  // Survey Fields
  // The actual GF field type is 'survey' with inputType controlling behavior.
  // The REST API returns type='survey' with inputType='checkbox'/'radio'/'select'/'likert'/'rank'/'rating'/'text'/'textarea'.
  survey: {
    type: 'survey',
    label: 'Survey',
    category: 'survey',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'varies',
      format: 'inputType-dependent',
      // radio/select/text/textarea/rating/rank: single string value
      // checkbox: dot-notation sub-inputs with "gsurveyNN" values
      // likert single-row: single "glikertN" string
      // likert multi-row: dot-notation sub-inputs with "rowValue:glikertN" values
    },
    variants: {
      radio: { label: 'Radio', settings: { inputType: 'radio' }, storage: { type: 'string', format: 'single' }, hasChoices: true },
      checkbox: { label: 'Checkbox', settings: { inputType: 'checkbox' }, storage: { type: 'compound', format: 'dotNotation' }, hasChoices: true },
      select: { label: 'Dropdown', settings: { inputType: 'select' }, storage: { type: 'string', format: 'single' }, hasChoices: true },
      likert: { label: 'Likert', settings: { inputType: 'likert' }, storage: { type: 'varies', format: 'single-or-dotNotation' }, hasChoices: true },
      rank: { label: 'Rank', settings: { inputType: 'rank' }, storage: { type: 'string', format: 'single' }, hasChoices: true },
      rating: { label: 'Rating', settings: { inputType: 'rating' }, storage: { type: 'string', format: 'single' }, hasChoices: true },
      text: { label: 'Text', settings: { inputType: 'text' }, storage: { type: 'string', format: 'single' } },
      textarea: { label: 'Textarea', settings: { inputType: 'textarea' }, storage: { type: 'string', format: 'single' } }
    }
  },

  // Legacy survey entries (kept for backward compat with existing forms using these types)
  survey_likert: {
    type: 'survey_likert',
    label: 'Likert',
    category: 'survey',
    supportsRequired: true,
    supportsConditionalLogic: true,
    storage: {
      type: 'varies',
      format: 'single-or-dotNotation',
      // Single-row: single "glikertN" string (no inputs)
      // Multi-row: dot-notation sub-inputs with "rowValue:glikertN" per row (has inputs)
    },
    hasChoices: true
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
      // GP Nested Forms stores a comma-separated string of child entry ids
      // (e.g. "101,102") in one TEXT column: save does implode(',', ids), read
      // does explode(',').
      // (gp-nested-forms class-gp-field-nested-form.php santize_nested_form_field_value.)
      type: 'string',
      format: 'commaSeparated'
    },
    isNested: true,
    // Provided by the GP Nested Forms add-on (needs the Spellbook framework,
    // formerly Gravity Perks). Configure these on the field:
    requiresAddon: 'gp-nested-forms',
    settings: {
      gpnfForm: {
        required: true,
        type: 'string',
        description: 'Child form id whose entries are nested under this field.',
      },
      gpnfFields: {
        type: 'array',
        description: 'Summary Fields — the child-form field ids shown in the nested entries summary table (lets you choose which child fields display). A directory View lists the child entry ids; the field/single-entry view renders these fields as columns.',
      },
    },
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
      type: 'compound',
      format: 'dotNotation',
      // Each dropdown level = one sub-input (fieldId.1, fieldId.2, etc.)
      // Choices are a nested tree, not flat. Each sub-input holds a single value.
    },
    hasChoices: true,
    isCompound: true,
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
 * Fill in field ids for any fields that lack one, mirroring GF's max+1
 * convention — so callers (and small models driving the MCP in natural
 * language) don't have to hand-number fields. Explicit ids are preserved; new
 * ids come from above the highest existing id and never collide. When a field
 * receives a new id, any provided compound sub-input ids are re-based onto it
 * (e.g. "2.3" → "10.3"). Non-array input passes through unchanged.
 *
 * @param {Array<object>} fields
 * @returns {Array<object>} fields with ids filled in
 */
export function assignFieldIds(fields) {
  if (!Array.isArray(fields)) {
    return fields;
  }

  const used = new Set();
  for (const field of fields) {
    const id = Number(field?.id);
    if (Number.isInteger(id) && id > 0) {
      used.add(id);
    }
  }

  let next = (used.size ? Math.max(...used) : 0) + 1;

  return fields.map((field) => {
    const id = Number(field?.id);
    if (Number.isInteger(id) && id > 0) {
      return field;
    }

    while (used.has(next)) {
      next++;
    }
    const newId = next++;
    used.add(newId);

    // Re-base any provided compound sub-input ids onto the new field id.
    if (Array.isArray(field?.inputs)) {
      const inputs = field.inputs.map((input) => {
        const hasDottedId = input && typeof input.id === 'string' && input.id.includes('.');
        if (hasDottedId) {
          const sub = input.id.slice(input.id.indexOf('.') + 1);
          return { ...input, id: `${newId}.${sub}` };
        }
        return input;
      });
      return { ...field, id: newId, inputs };
    }

    return { ...field, id: newId };
  });
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

  // Credit card field sub-inputs. Per GF (class-gf-field-creditcard.php): .4 is
  // Card Type and .5 is Cardholder Name; only .1 (masked number) and .4 (card
  // type) are persisted. Mirrors generateSubInputs in field-manager.js.
  else if (field.type === 'creditcard') {
    subInputs.push(
      { id: `${baseId}.1`, label: 'Card Number', name: '' },
      { id: `${baseId}.2`, label: 'Expiration Date', name: '' },
      { id: `${baseId}.3`, label: 'Security Code', name: '' },
      { id: `${baseId}.4`, label: 'Card Type', name: '' },
      { id: `${baseId}.5`, label: 'Cardholder Name', name: '' }
    );
  }

  // Consent field sub-inputs.
  else if (field.type === 'consent') {
    subInputs.push(
      { id: `${baseId}.1`, label: 'Consent', name: '' },
      { id: `${baseId}.2`, label: 'Text', name: '' },
      { id: `${baseId}.3`, label: 'Revision', name: '' }
    );
  }

  return subInputs.length > 0 ? subInputs : null;
}

export default fieldRegistry;
