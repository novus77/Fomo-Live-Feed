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

test('keeps the hero headline to two deliberate lines and separates the sample label', () => {
  assert.equal((html.match(/class="hero-title-line"/g) ?? []).length, 2);
  assert.match(
    html,
    /class="stage-label-row"[\s\S]*class="sample-badge"[\s\S]*class="browser-frame"/,
  );
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
  // Three source links (header nav, mobile button, footer) plus four
  // per-version release links inside the updates section.
  assert.equal(html.split(repositoryUrl).length - 1, 8);
  assert.match(html, /class="mobile-github"/);
});

test('presents a changelog section with one item per released version', () => {
  assert.match(html, /class="updates shell" id="updates"/);
  assert.equal((html.match(/class="release-item"/g) ?? []).length, 5);
  assert.equal((html.match(/class="version-tag"/g) ?? []).length, 5);
  assert.equal((html.match(/class="release-link"/g) ?? []).length, 5);
  for (const version of ['v0.5.0', 'v0.4.0', 'v0.3.0', 'v0.2.0', 'v0.1.0']) {
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
  assert.match(html, /下载 v0\.5\.0 ZIP/);
  assert.match(html, /开源代码/);
  assert.match(html, /SHA-256/);
});

test('downloads the current v0.5.0 Chrome package', () => {
  assert.match(
    script,
    /releases\/download\/v0\.5\.0\/Fomo-Live-Feed-v0\.5\.0-chrome\.zip/,
  );
});

test('explains the v0.5.0 unified Fomo and Pump feed', () => {
  assert.match(html, /releases\/tag\/v0\.5\.0/);
  assert.match(html, /Fomo.*Pump|Pump.*Fomo/);
  assert.match(html, /全部来源/);
  assert.match(html, /一秒/);
});

test('explains the v0.4.0 display-mode behavior', () => {
  assert.match(html, /releases\/tag\/v0\.4\.0/);
  assert.match(html, /侧边栏和悬浮窗/);
  assert.match(html, /始终置顶/);
  assert.match(html, /跨.*标签页/);
  assert.match(html, /不占用侧边栏/);
  assert.match(html, /数据.*同步/);
});

test('the product demo exposes four accessible tabs', () => {
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 4);
  assert.match(html, /aria-controls="demo-feed"/);
  assert.match(html, /aria-labelledby="tab-feed"/);
  assert.match(html, /id="tab-display-mode"/);
  assert.match(html, /aria-controls="demo-display-mode"/);
  assert.match(html, /id="demo-display-mode"/);
  assert.match(html, /aria-labelledby="tab-display-mode"/);
  assert.match(html, /data-demo-tab="display-mode"/);
  assert.match(html, /data-demo-panel="display-mode"/);
});

test('supports keyboard navigation between demo tabs', () => {
  assert.match(script, /ArrowRight/);
  assert.match(script, /ArrowLeft/);
  assert.match(script, /tabIndex/);
});
