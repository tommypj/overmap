import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../web/md.js';

test('escapes raw html', () => {
  const h = renderMarkdown('hi <script>alert(1)</script> & <img src=x onerror=y>');
  assert.ok(!h.includes('<script'));
  assert.ok(!h.includes('<img'));
  assert.ok(h.includes('&lt;script&gt;'));
  assert.ok(h.includes('&amp;'));
});

test('blocks javascript: and other schemes in links', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x']) {
    const h = renderMarkdown(`[x](${bad})`);
    assert.ok(!/href=/i.test(h), bad + ' -> ' + h);
  }
  const ok = renderMarkdown('[a](https://example.com/p?q=1&r=2) [b](docs/x.md)');
  assert.ok(ok.includes('href="https://example.com/p?q=1&amp;r=2"'));
  assert.ok(ok.includes('href="docs/x.md"'));
  assert.ok(ok.includes('rel="noopener noreferrer"'));
});

test('quotes cannot break out of attributes', () => {
  const h = renderMarkdown('[x](https://a.b/"onmouseover="alert(1))');
  assert.ok(h.includes('&quot;onmouseover=&quot;'));
  assert.ok(!h.includes('"onmouseover="'));
});

test('renders a table', () => {
  const h = renderMarkdown('| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |');
  assert.ok(h.includes('<table>'));
  assert.equal((h.match(/<th[ >]/g) || []).length, 2);
  assert.equal((h.match(/<td/g) || []).length, 4);
});

test('renders a fenced block without inline processing', () => {
  const h = renderMarkdown('```js\nconst a = "<b>" * 2;\n**not bold**\n```');
  assert.ok(h.includes('<pre><code'));
  assert.ok(h.includes('&lt;b&gt;'));
  assert.ok(!h.includes('<strong>'));
});

test('renders a task list', () => {
  const h = renderMarkdown('- [x] done\n- [ ] todo\n- plain');
  assert.equal((h.match(/<input type="checkbox"/g) || []).length, 2);
  assert.ok(h.includes('checked'));
  assert.ok(h.includes('<ul'));
});

test('headings, emphasis, inline code, ordered list', () => {
  const h = renderMarkdown('# T\n\nsome **bold** and *it* and `a<b`\n\n1. one\n2. two');
  assert.ok(h.includes('<h1>T</h1>'));
  assert.ok(h.includes('<strong>bold</strong>'));
  assert.ok(h.includes('<em>it</em>'));
  assert.ok(h.includes('<code>a&lt;b</code>'));
  assert.ok(h.includes('<ol>'));
});

test('relative images are rewritten through resolveRel; remote images are not loaded', () => {
  const h = renderMarkdown('![shot](img/a.png)', { resolveRel: (p) => 'api/file?path=' + encodeURIComponent(p) });
  assert.ok(h.includes('src="api/file?path=img%2Fa.png"'));
  const r = renderMarkdown('![x](https://evil.example/t.png)');
  assert.ok(!r.includes('<img'));
  assert.ok(r.includes('https://evil.example/t.png'));
});
