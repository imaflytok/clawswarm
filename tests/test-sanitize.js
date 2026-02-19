/**
 * Unit tests for ClawSwarm content security middleware
 */

const {
  contentSecurityMiddleware,
  sanitizeContent,
  sanitizeName,
  sanitizeUrl,
  sanitizeString,
  sanitizeStringArray,
  sanitizeObject,
  escapeHtml
} = require('/opt/moltswarm/src/middleware/sanitize');

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Got:      ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(name, actual, substring) {
  if (actual.includes(substring)) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     Expected to include: ${JSON.stringify(substring)}`);
    console.log(`     Got: ${JSON.stringify(actual)}`);
  }
}

function assertNotIncludes(name, actual, substring) {
  if (!actual.includes(substring)) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     Expected NOT to include: ${JSON.stringify(substring)}`);
    console.log(`     Got: ${JSON.stringify(actual)}`);
  }
}

// ==========================================
console.log('\n🛡️  escapeHtml()');
// ==========================================
assert('escapes <', escapeHtml('<'), '&lt;');
assert('escapes >', escapeHtml('>'), '&gt;');
assert('escapes &', escapeHtml('&'), '&amp;');
assert('escapes "', escapeHtml('"'), '&quot;');
assert("escapes '", escapeHtml("'"), '&#x27;');
assert('escapes /', escapeHtml('/'), '&#x2F;');
assert('handles null', escapeHtml(null), null);
assert('handles undefined', escapeHtml(undefined), undefined);
assert('handles number', escapeHtml(42), 42);
assert('handles empty string', escapeHtml(''), '');
assert('full XSS payload', escapeHtml('<script>alert(1)</script>'),
  '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;');

// ==========================================
console.log('\n🛡️  sanitizeContent()');
// ==========================================
assert('strips script tags', sanitizeContent('<script>alert(1)</script>'), '');
assert('strips script with attrs', sanitizeContent('<script src="evil.js"></script>'), '');
assert('strips img onerror', sanitizeContent('<img src=x onerror="alert(1)">'), '');
assert('strips iframe', sanitizeContent('<iframe src="evil.com"></iframe>'), '');
assert('strips object tag', sanitizeContent('<object data="evil.swf"></object>'), '');
assert('strips embed tag', sanitizeContent('<embed src="evil.swf">'), '');
assert('strips form tag', sanitizeContent('<form action="evil.com"><input></form>'), '');
assert('strips style tag with content', sanitizeContent('<style>body{display:none}</style>'), '');
assert('strips meta tag', sanitizeContent('<meta http-equiv="refresh" content="0;url=evil.com">'), '');
assert('strips link tag', sanitizeContent('<link rel="stylesheet" href="evil.css">'), '');
assert('strips onload handler', sanitizeContent('<body onload="alert(1)">'), '');
assert('strips onclick handler', sanitizeContent('<div onclick="alert(1)">click</div>'), 'click');
assert('strips onmouseover', sanitizeContent('<a onmouseover="alert(1)">hover</a>'), 'hover');
assert('strips javascript: URI', sanitizeContent('javascript:alert(1)'), 'alert(1)');
assertNotIncludes('strips data: base64', sanitizeContent('data:text/html;base64,PHNjcmlwdD4='), 'base64');
assert('preserves plain text', sanitizeContent('Hello world'), 'Hello world');
assert('preserves newlines', sanitizeContent('line1\nline2'), 'line1\nline2');
assert('preserves markdown bold', sanitizeContent('**bold text**'), '**bold text**');
assert('preserves emoji', sanitizeContent('🐝 Hello 👁️'), '🐝 Hello 👁️');
assert('handles null returns empty', sanitizeContent(null), '');
assert('handles empty', sanitizeContent(''), '');

// Length limits
assert('truncates at maxLength', sanitizeContent('A'.repeat(6000), 100).length, 100);
assert('preserves under maxLength', sanitizeContent('Hello', 100), 'Hello');

// Control characters
assert('strips null byte', sanitizeContent('hello\x00world'), 'helloworld');
assert('strips bell', sanitizeContent('hello\x07world'), 'helloworld');
assert('preserves tab', sanitizeContent('hello\tworld'), 'hello\tworld');
assert('preserves newline', sanitizeContent('hello\nworld'), 'hello\nworld');

// Nested/tricky XSS
assertNotIncludes('strips nested script', sanitizeContent('<scr<script>ipt>alert(1)</scr</script>ipt>'), '<script');
assert('strips uppercase SCRIPT', sanitizeContent('<SCRIPT>alert(1)</SCRIPT>'), '');
assert('strips mixed case ScRiPt', sanitizeContent('<ScRiPt>alert(1)</ScRiPt>'), '');
assert('strips SVG onload', sanitizeContent('<svg onload="alert(1)">'), '');
assert('strips event with spaces', sanitizeContent('<div on click="alert(1)">'), '');

// ==========================================
console.log('\n🛡️  sanitizeName()');
// ==========================================
assert('keeps normal name', sanitizeName('Buzz'), 'Buzz');
assert('keeps name with spaces', sanitizeName('Agent Smith'), 'Agent Smith');
assert('keeps hyphenated', sanitizeName('buzz-jr'), 'buzz-jr');
assert('keeps underscored', sanitizeName('agent_123'), 'agent_123');
assertNotIncludes('strips HTML from names', sanitizeName('<b>evil</b>'), '<');
assertNotIncludes('strips angle brackets', sanitizeName('<script>alert(1)</script>'), '<');
assertNotIncludes('strips quotes', sanitizeName('"onmouseover="alert(1)"'), '"');
assert('truncates long names', sanitizeName('A'.repeat(200), 100).length, 100);
assert('trims whitespace', sanitizeName('  Buzz  '), 'Buzz');
assert('preserves emoji in name', sanitizeName('🐝 Buzz'), '🐝 Buzz');

// ==========================================
console.log('\n🛡️  sanitizeUrl()');
// ==========================================
assert('allows https', sanitizeUrl('https://example.com'), 'https://example.com');
assert('allows http', sanitizeUrl('http://example.com'), 'http://example.com');
assert('blocks javascript:', sanitizeUrl('javascript:alert(1)'), '');
assert('blocks data:', sanitizeUrl('data:text/html,<script>alert(1)</script>'), '');
assert('blocks ftp:', sanitizeUrl('ftp://evil.com'), '');
assert('blocks empty', sanitizeUrl(''), '');
assert('blocks null', sanitizeUrl(null), null);
assert('blocks very long URL', sanitizeUrl('https://x.com/' + 'a'.repeat(3000)), '');
assert('trims whitespace', sanitizeUrl('  https://example.com  '), 'https://example.com');

// ==========================================
console.log('\n🛡️  sanitizeStringArray()');
// ==========================================
{
  const result = sanitizeStringArray(['trading', 'ops', '<script>evil</script>']);
  assert('keeps valid items', result[0], 'trading');
  assert('keeps valid items (2)', result[1], 'ops');
  assertNotIncludes('strips HTML from items', result[2], '<');
  
  const longArr = Array.from({length: 100}, (_, i) => `item${i}`);
  assert('caps at maxItems', sanitizeStringArray(longArr, 10).length, 10);
  
  assert('handles non-array', sanitizeStringArray('not-array').length, 0);
  assert('handles null', sanitizeStringArray(null).length, 0);
  assert('filters non-strings', sanitizeStringArray([1, true, null, 'ok']).length, 1);
}

// ==========================================
console.log('\n🛡️  sanitizeObject()');
// ==========================================
{
  const obj = sanitizeObject({
    name: '<script>evil</script>',
    count: 42,
    active: true,
    nested: { data: '<img onerror="alert(1)">' }
  });
  assertNotIncludes('strips HTML from string values', obj.name, '<');
  assert('preserves numbers', obj.count, 42);
  assert('preserves booleans', obj.active, true);
  assertNotIncludes('strips HTML from nested objects', obj.nested.data, '<');
  
  // Depth limit
  let deep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };
  const result = sanitizeObject(deep);
  assert('limits nesting depth', JSON.stringify(result).includes('deep'), false);
  
  // Key limit
  const manyKeys = {};
  for (let i = 0; i < 150; i++) manyKeys[`key${i}`] = 'val';
  assert('caps at 100 keys', Object.keys(sanitizeObject(manyKeys)).length, 100);
}

// ==========================================
console.log('\n🛡️  contentSecurityMiddleware()');
// ==========================================
{
  // Mock Express req/res/next
  function mockReq(body, query = {}) {
    return { body, query };
  }
  function mockRes() {
    let statusCode = 200;
    let jsonData = null;
    return {
      status(code) { statusCode = code; return this; },
      json(data) { jsonData = data; },
      get statusCode() { return statusCode; },
      get jsonData() { return jsonData; }
    };
  }

  // Test content sanitization
  const req1 = mockReq({ content: '<script>alert(1)</script>Hello', name: '<b>evil</b>' });
  const res1 = mockRes();
  let nextCalled = false;
  contentSecurityMiddleware(req1, res1, () => { nextCalled = true; });
  assert('middleware calls next()', nextCalled, true);
  assertNotIncludes('middleware sanitizes content', req1.body.content, '<');
  assertIncludes('middleware preserves text in content', req1.body.content, 'Hello');
  assertNotIncludes('middleware sanitizes name', req1.body.name, '<');

  // Test URL sanitization
  const req2 = mockReq({ url: 'javascript:alert(1)', webhook_url: 'https://ok.com' });
  const res2 = mockRes();
  contentSecurityMiddleware(req2, res2, () => {});
  assert('blocks javascript: URL', req2.body.url, '');
  assert('allows https webhook', req2.body.webhook_url, 'https://ok.com');

  // Test array sanitization
  const req3 = mockReq({ capabilities: ['<script>evil</script>', 'trading', 123] });
  const res3 = mockRes();
  contentSecurityMiddleware(req3, res3, () => {});
  assert('sanitizes capability arrays', req3.body.capabilities.length, 2);
  assertNotIncludes('strips HTML from capabilities', req3.body.capabilities[0], '<');

  // Test oversized payload
  const req4 = mockReq({ content: 'A'.repeat(60000) });
  const res4 = mockRes();
  let next4Called = false;
  contentSecurityMiddleware(req4, res4, () => { next4Called = true; });
  assert('rejects oversized payload', next4Called, false);
  assert('returns 413 for oversized', res4.statusCode, 413);

  // Test query param sanitization
  const req5 = mockReq({}, { search: '<script>evil</script>hello' });
  const res5 = mockRes();
  contentSecurityMiddleware(req5, res5, () => {});
  assertNotIncludes('sanitizes query params', req5.query.search, '<');
  assertIncludes('preserves query text', req5.query.search, 'hello');

  // Test empty/null body
  const req6 = { body: null, query: {} };
  const res6 = mockRes();
  let next6Called = false;
  contentSecurityMiddleware(req6, res6, () => { next6Called = true; });
  assert('handles null body', next6Called, true);

  // Test metadata object sanitization
  const req7 = mockReq({ metadata: { evil: '<script>xss</script>', nested: { deep: '<img onerror=x>' } } });
  const res7 = mockRes();
  contentSecurityMiddleware(req7, res7, () => {});
  assertNotIncludes('sanitizes metadata strings', req7.body.metadata.evil, '<');
  assertNotIncludes('sanitizes nested metadata', req7.body.metadata.nested.deep, '<');
}

// ==========================================
console.log('\n🛡️  OWASP XSS Attack Vectors');
// ==========================================
// From OWASP XSS Filter Evasion Cheat Sheet
const vectors = [
  ['Basic script', '<script>alert("XSS")</script>'],
  ['IMG onerror', '<img src=x onerror=alert(1)>'],
  ['SVG onload', '<svg/onload=alert(1)>'],
  ['Body onload', '<body onload=alert(1)>'],
  ['Event handler', '<div onmouseover="alert(1)">X</div>'],
  ['Javascript URI', '<a href="javascript:alert(1)">click</a>'],
  ['Data URI', '<a href="data:text/html,<script>alert(1)</script>">click</a>'],
  ['Iframe inject', '<iframe src="javascript:alert(1)">'],
  ['Object tag', '<object data="javascript:alert(1)">'],
  ['Embed tag', '<embed src="javascript:alert(1)">'],
  ['Style expression', '<div style="background:url(javascript:alert(1))">'],
  ['Base tag hijack', '<base href="https://evil.com/">'],
  ['Form injection', '<form action="https://evil.com/steal"><input name="q">'],
  ['Input onfocus', '<input onfocus="alert(1)" autofocus>'],
  ['Select tag', '<select><option>safe</option></select>'],
  ['Textarea', '<textarea><script>alert(1)</script></textarea>'],
  ['Button onclick', '<button onclick="alert(1)">Click</button>'],
  ['Marquee (old)', '<marquee onstart="alert(1)">'],
  ['Details ontoggle', '<details open ontoggle="alert(1)">'],
  ['Meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
];

for (const [name, payload] of vectors) {
  const clean = sanitizeContent(payload);
  const hasDanger = clean.includes('<script') || clean.includes('<iframe') || 
                    clean.includes('<object') || clean.includes('<embed') ||
                    clean.includes('<form') || clean.includes('<input') ||
                    clean.includes('<select') || clean.includes('<textarea') ||
                    clean.includes('<button') || clean.includes('<meta') ||
                    clean.includes('<base') || clean.includes('<style') ||
                    clean.includes('onerror=') || clean.includes('onload=') ||
                    clean.includes('onclick=') || clean.includes('onmouseover=') ||
                    clean.includes('onfocus=') || clean.includes('ontoggle=') ||
                    clean.includes('onstart=') ||
                    clean.includes('javascript:');
  
  if (!hasDanger) {
    passed++;
    console.log(`  ✅ Blocked: ${name}`);
  } else {
    failed++;
    console.log(`  ❌ LEAKED: ${name}`);
    console.log(`     Input:  ${payload}`);
    console.log(`     Output: ${clean}`);
  }
}

// ==========================================
// Summary
// ==========================================
console.log(`\n${'='.repeat(50)}`);
console.log(`🏁 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 ALL TESTS PASSED!');
  process.exit(0);
}
