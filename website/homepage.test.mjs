import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./main.js', import.meta.url), 'utf8');

test('uses one consistent Fomo Live Feed brand', () => {
  assert.match(html, /Fomo Live Feed/);
  assert.doesNotMatch(html, /FOMO<span class="brand-accent">\.LIVE/);
});

test('keeps deployment assets inside the website directory', () => {
  assert.doesNotMatch(html, /\.\.\/public\//);
  assert.match(html, /\.\/assets\/icons\/icon-128\.png/);
  assert.match(html, /\.\/assets\/chains\/base\.svg/);
});

test('keeps one product demo and three feature cards', () => {
  assert.equal((html.match(/\bdemo-section\b/g) ?? []).length, 1);
  assert.equal((html.match(/class="feature-card/g) ?? []).length, 3);
  assert.doesNotMatch(html, /class="proof-section/);
});

test('fills the primary feature card with four representative activity rows', () => {
  assert.equal((html.match(/class="mini-event /g) ?? []).length, 4);
  assert.match(html, /mini-event-buy/);
  assert.match(html, /mini-event-sell/);
  assert.match(html, /mini-event-thesis/);
  assert.match(html, /mini-event-transfer/);
});

test('links to the public GitHub repository from navigation and footer', () => {
  const repositoryUrl = 'https://github.com/novus77/Fomo-Live-Feed';
  // Three source links (header nav, mobile button, footer) plus three
  // per-version release links inside the updates section.
  assert.equal(html.split(repositoryUrl).length - 1, 6);
  assert.match(html, /class="mobile-github"/);
});

test('presents a changelog section with one item per released version', () => {
  assert.match(html, /class="updates shell" id="updates"/);
  assert.equal((html.match(/class="release-item"/g) ?? []).length, 3);
  assert.equal((html.match(/class="version-tag"/g) ?? []).length, 3);
  assert.equal((html.match(/class="release-link"/g) ?? []).length, 3);
  for (const version of ['v0.3.0', 'v0.2.0', 'v0.1.0']) {
    assert.match(html, new RegExp(`releases/tag/${version}`));
  }
});

test('uses consistent vector icons for interface controls', () => {
  assert.ok((html.match(/class="ui-icon/g) ?? []).length >= 10);
  assert.doesNotMatch(html, /<span>⌕<\/span>|<span>◫<\/span>|<span>⚙<\/span>/);
});

test('includes the Chrome developer mode installation step', () => {
  assert.match(html, /打开开发者模式/);
});

test('labels sample data and describes the ZIP download accurately', () => {
  assert.match(html, /示例界面/);
  assert.match(html, /下载 v0\.3\.0 ZIP/);
  assert.match(html, /开源代码/);
  assert.match(html, /SHA-256/);
});

test('the product demo exposes three accessible tabs', () => {
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 3);
  assert.match(html, /aria-controls="demo-feed"/);
  assert.match(html, /aria-labelledby="tab-feed"/);
});

test('supports keyboard navigation between demo tabs', () => {
  assert.match(script, /ArrowRight/);
  assert.match(script, /ArrowLeft/);
  assert.match(script, /tabIndex/);
});
