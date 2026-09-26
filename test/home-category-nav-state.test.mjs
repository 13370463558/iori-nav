import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('public/js/home-category-nav.js', 'utf8');

test('client category navigation synchronizes valid categories to the URL', () => {
  assert.match(source, /url\.searchParams\.set\('catalog', catalogId \|\| 'all'\)/);
  assert.match(source, /window\.history\[method\]\(\{ catalog: catalogId \|\| 'all' \}, '', url\)/);
  assert.match(source, /renderCatalog\(catalog, \{ historyMode: 'push' \}\)/);
  assert.match(source, /if \(!\/\^\\d\+\$\/\.test\(normalized\)\) return null/);
  assert.match(source, /Ignoring invalid catalog navigation/);
});

test('popstate restores category content, heading and navigation without creating history entries', () => {
  assert.match(source, /window\.addEventListener\('popstate', \(\) => \{/);
  assert.match(source, /resolveCatalog\(getCatalogFromUrl\(\)\)/);
  assert.match(source, /cardController\.renderSites\(sites\)/);
  assert.match(source, /updateNavigationState\(catalog\.id\)/);
  assert.match(source, /Home\.updateHeading\?\.\(null, catalog\.name, sites\.length\)/);
  assert.doesNotMatch(source.match(/window\.addEventListener\('popstate',[\s\S]*?\n    \}\);/)?.[0] || '', /historyMode/);
});

test('category changes rebuild cards before reapplying the current local search', () => {
  const renderCatalog = source.match(/function renderCatalog\(catalog, options = \{\}\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const renderIndex = renderCatalog.indexOf('cardController.renderSites(sites)');
  const headingIndex = renderCatalog.indexOf('Home.updateHeading?.(null, catalog.name, sites.length)');
  const searchIndex = renderCatalog.indexOf('Home.reapplyLocalSearchFilter?.()');

  assert.ok(renderIndex >= 0, 'category cards should be rebuilt');
  assert.ok(headingIndex > renderIndex, 'category heading should update after rebuilding cards');
  assert.ok(searchIndex > headingIndex, 'local search should be reapplied after category state is updated');
});
