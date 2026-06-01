import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/markdown.js';

test('renders ordered lists with valid list markup', () => {
  assert.equal(
    renderMarkdown('1. first\n2. second'),
    '<ol><li>first</li><li>second</li></ol>',
  );
});

test('renders unordered lists without line break elements', () => {
  assert.equal(
    renderMarkdown('- first\n- second'),
    '<ul><li>first</li><li>second</li></ul>',
  );
});

test('renders fenced code blocks as escaped text', () => {
  assert.equal(
    renderMarkdown('```\n<script>alert(1)</script>\n```'),
    '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
  );
});

test('escapes HTML while preserving supported inline markdown', () => {
  assert.equal(
    renderMarkdown('<img src=x> **safe** `code`'),
    '<p>&lt;img src=x&gt; <strong>safe</strong> <code>code</code></p>',
  );
});
