/**
 * Field-output cases — one per Gravity Forms field type, covering the
 * displayable surface (data fields; layout-only types like page/section/html/
 * captcha/creditcard are excluded — they have no entry value to render).
 *
 * The runner (field-output.mjs) builds ONE form from `build(id)`, seeds ONE
 * entry from `value(id)`, then renders each field's cell HTML via the
 * gk-gravityview/view-field-render ability (staged_slot) and checks `expect`.
 *
 * `expect`  — substrings the rendered HTML must contain (strict content check).
 * `lenient` — when content is impractical to pin (signature image, survey
 *             codes), require only non-empty, error-free output.
 *
 * Choice fields deliberately split on the enableChoiceValue rule we verified
 * against GF source/tests: `select` enables Show Values (entry stores the
 * VALUE, View displays the LABEL); `radio`/`multiselect` leave it off (entry
 * stores the LABEL). Both must DISPLAY the human label in the output.
 */

const choices = (pairs) => pairs.map(([text, value]) => (value === undefined ? { text } : { text, value }));
const subInputs = (id, labels) => labels.map(([sub, label]) => ({ id: `${id}.${sub}`, label }));

export const FIELDS = [
  {
    type: 'text', label: 'Single Line',
    build: (id) => ({ id, type: 'text', label: 'Single Line' }),
    value: (id) => ({ [id]: 'Hello World' }),
    expect: ['Hello World'],
  },
  {
    type: 'textarea', label: 'Paragraph',
    build: (id) => ({ id, type: 'textarea', label: 'Paragraph' }),
    value: (id) => ({ [id]: 'First line and more' }),
    expect: ['First line and more'],
  },
  {
    type: 'email', label: 'Email',
    build: (id) => ({ id, type: 'email', label: 'Email' }),
    value: (id) => ({ [id]: 'ada@example.com' }),
    expect: ['ada@example.com'],
  },
  {
    type: 'number', label: 'Number',
    build: (id) => ({ id, type: 'number', label: 'Number' }),
    value: (id) => ({ [id]: '42' }),
    expect: ['42'],
  },
  {
    type: 'phone', label: 'Phone',
    build: (id) => ({ id, type: 'phone', label: 'Phone' }),
    value: (id) => ({ [id]: '(555) 867-5309' }),
    expect: ['867-5309'],
  },
  {
    type: 'website', label: 'Website',
    build: (id) => ({ id, type: 'website', label: 'Website' }),
    value: (id) => ({ [id]: 'https://example.com/path' }),
    expect: ['example.com'],
  },
  {
    // Show Values ON + GravityView's choice_display='value' → output the VALUE.
    // (choice_display only exists when the field has distinct value/label.)
    type: 'select', label: 'Dropdown (choice_display=value)',
    build: (id) => ({ id, type: 'select', label: 'Department (value)', enableChoiceValue: true,
      choices: choices([['Engineering', 'eng'], ['Design', 'design'], ['Product', 'product']]) }),
    value: (id) => ({ [id]: 'eng' }),
    settings: { choice_display: 'value' },
    expect: ['eng'],
  },
  {
    // SAME field, choice_display='label' → output the LABEL. Proves the
    // GravityView setting — not just the stored value — controls the output.
    type: 'select', label: 'Dropdown (choice_display=label)',
    build: (id) => ({ id, type: 'select', label: 'Department (label)', enableChoiceValue: true,
      choices: choices([['Engineering', 'eng'], ['Design', 'design'], ['Product', 'product']]) }),
    value: (id) => ({ [id]: 'eng' }),
    settings: { choice_display: 'label' },
    expect: ['Engineering'],
  },
  {
    // Show Values OFF: entry stores the label text directly.
    type: 'radio', label: 'Radio (values off)',
    build: (id) => ({ id, type: 'radio', label: 'Seniority',
      choices: choices([['Junior'], ['Mid'], ['Senior']]) }),
    value: (id) => ({ [id]: 'Senior' }),
    expect: ['Senior'],
  },
  {
    type: 'checkbox', label: 'Checkboxes',
    build: (id) => ({ id, type: 'checkbox', label: 'Perks',
      choices: choices([['Remote'], ['Equity'], ['Learning budget']]),
      inputs: subInputs(id, [['1', 'Remote'], ['2', 'Equity'], ['3', 'Learning budget']]) }),
    // Checkbox stores each selected choice in its sub-input.
    value: (id) => ({ [`${id}.1`]: 'Remote', [`${id}.3`]: 'Learning budget' }),
    expect: ['Remote', 'Learning budget'],
  },
  {
    // Show Values OFF: array of labels; commas in a value would split.
    type: 'multiselect', label: 'Multi Select (values off)',
    build: (id) => ({ id, type: 'multiselect', label: 'Skills',
      choices: choices([['PHP'], ['JavaScript'], ['Go']]) }),
    value: (id) => ({ [id]: ['PHP', 'Go'] }),
    expect: ['PHP', 'Go'],
  },
  {
    type: 'name', label: 'Name',
    build: (id) => ({ id, type: 'name', label: 'Full Name', nameFormat: 'advanced',
      inputs: subInputs(id, [['3', 'First'], ['6', 'Last']]) }),
    value: (id) => ({ [`${id}.3`]: 'Ada', [`${id}.6`]: 'Lovelace' }),
    expect: ['Ada', 'Lovelace'],
  },
  {
    type: 'address', label: 'Address',
    build: (id) => ({ id, type: 'address', label: 'Location',
      inputs: subInputs(id, [['1', 'Street'], ['3', 'City'], ['4', 'State'], ['5', 'ZIP'], ['6', 'Country']]) }),
    value: (id) => ({ [`${id}.1`]: '1 Infinite Loop', [`${id}.3`]: 'Cupertino', [`${id}.4`]: 'CA', [`${id}.5`]: '95014' }),
    expect: ['Cupertino', 'CA'],
  },
  {
    type: 'date', label: 'Date',
    build: (id) => ({ id, type: 'date', label: 'Available From', dateFormat: 'ymd_dash' }),
    value: (id) => ({ [id]: '2026-06-17' }),
    expect: ['2026'],
  },
  {
    // GF stores time as a combined "HH:MM am/pm" value at the field id (seeding
    // the .1/.2/.3 sub-inputs over REST does NOT populate it); GravityView
    // renders it as "12:30 PM".
    type: 'time', label: 'Time',
    build: (id) => ({ id, type: 'time', label: 'Preferred Time', timeFormat: '12' }),
    value: (id) => ({ [id]: '12:30 pm' }),
    expect: ['12', '30'],
  },
  {
    type: 'list', label: 'List (multi-column)',
    build: (id) => ({ id, type: 'list', label: 'Work History', enableColumns: true,
      choices: choices([['Employer'], ['Role']]) }),
    value: (id) => ({ [id]: [{ Employer: 'Acme Corp', Role: 'Engineer' }] }),
    expect: ['Acme Corp', 'Engineer'],
  },
  {
    type: 'fileupload', label: 'File Upload',
    build: (id) => ({ id, type: 'fileupload', label: 'Resume' }),
    value: (id) => ({ [id]: 'https://example.com/uploads/resume.pdf' }),
    expect: ['resume.pdf'],
  },
  {
    // Free-text survey input keeps the assertion deterministic (vs gsurvey codes).
    type: 'survey', label: 'Survey (text)',
    build: (id) => ({ id, type: 'survey', label: 'Why this role?', inputType: 'text' }),
    value: (id) => ({ [id]: 'I love hard problems' }),
    expect: ['I love hard problems'],
  },
  {
    type: 'product', label: 'Product (single)',
    build: (id) => ({ id, type: 'product', label: 'Plan', inputType: 'singleproduct',
      inputs: subInputs(id, [['1', 'Name'], ['2', 'Price'], ['3', 'Quantity']]) }),
    value: (id) => ({ [`${id}.1`]: 'Pro Plan', [`${id}.2`]: '$49.00', [`${id}.3`]: '1' }),
    expect: ['Pro Plan'],
  },
  {
    type: 'consent', label: 'Consent',
    build: (id) => ({ id, type: 'consent', label: 'Agree to terms', checkboxLabel: 'I agree to the terms',
      inputs: subInputs(id, [['1', 'Consent'], ['2', 'Text'], ['3', 'Revision']]) }),
    value: (id) => ({ [`${id}.1`]: '1', [`${id}.2`]: 'I agree to the terms', [`${id}.3`]: '1' }),
    expect: ['agree'],
  },
  // Excluded on a GF + GravityView target: add-on fields whose OUTPUT needs
  // their add-on installed (and a real artifact) to render anything — they'd
  // render an empty cell here, which the suite now (correctly) fails rather
  // than waves through. signature (GF Signature add-on, + real signature image),
  // chainedselect (Chained Selects), the rich quiz/poll/survey-rating variants.
  // Mint a site with those add-ons to extend coverage to them.
];
