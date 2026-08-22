import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import {
  EN_MESSAGES,
  resolveBrowserLocale,
  translate,
  ZH_MESSAGES,
  type MessageKey,
} from '../../src/i18n/catalog';

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

const extractPlaceholders = (template: string): string[] => {
  const names: string[] = [];

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];

    if (name !== undefined) {
      names.push(name);
    }
  }

  return names;
};

const enKeys = Object.keys(EN_MESSAGES);
const zhKeys = Object.keys(ZH_MESSAGES);

describe('i18n catalog', () => {
  it('exposes every English key in the Chinese catalog and vice versa', () => {
    expect(zhKeys.sort()).toEqual(enKeys.sort());
  });

  it('has no empty or whitespace-only message values', () => {
    for (const key of enKeys) {
      const en = EN_MESSAGES[key as MessageKey];
      const zh = ZH_MESSAGES[key as MessageKey];

      expect(en.trim().length).toBeGreaterThan(0);
      expect(zh.trim().length).toBeGreaterThan(0);
    }
  });

  it('contains no user-facing toast controls after moving to Side Panel-only delivery', () => {
    expect(enKeys).not.toContain('toast.dismiss');
    expect(EN_MESSAGES['card.muteNote']).not.toMatch(/toast/i);
    expect(ZH_MESSAGES['card.muteNote']).not.toContain('通知');
  });

  it('uses the same placeholder names in both locales for every key', () => {
    for (const key of enKeys) {
      const en = EN_MESSAGES[key as MessageKey];
      const zh = ZH_MESSAGES[key as MessageKey];

      expect(extractPlaceholders(zh).sort()).toEqual(
        extractPlaceholders(en).sort(),
      );
    }
  });

  it('resolves every declared placeholder when its values are supplied', () => {
    for (const key of enKeys) {
      const template = EN_MESSAGES[key as MessageKey];
      const names = extractPlaceholders(template);

      if (names.length === 0) {
        continue;
      }

      const values = Object.fromEntries(
        names.map((name, index) => [name, `value-${index}`]),
      );

      for (const locale of ['en', 'zh-CN'] as const) {
        const output = translate(locale, key as MessageKey, values);

        expect(output).not.toMatch(/\{|\}/);
        expect(output.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('translate', () => {
  it('localizes the developer support entry', () => {
    expect(translate('en', 'header.support')).toBe('Support');
    expect(translate('zh-CN', 'header.support')).toBe('打赏');
    expect(translate('en', 'support.groupTitle')).toBe(
      'Developer Co-creation Group',
    );
    expect(translate('zh-CN', 'support.groupTitle')).toBe('开发共创小群');
  });

  it('returns the English message for the en locale', () => {
    expect(translate('en', 'header.title')).toBe('Fomo Live Feed');
    expect(translate('en', 'connection.connected')).toBe('Connected');
  });

  it('returns the Chinese message for the zh-CN locale', () => {
    expect(translate('zh-CN', 'header.title')).toBe('Fomo 实时动态');
    expect(translate('zh-CN', 'connection.connected')).toBe('已连接');
  });

  it('interpolates string and number values into placeholders', () => {
    expect(
      translate('en', 'feed.countActive', { count: 3 }),
    ).toBe('Filters, 3 active');
    expect(
      translate('zh-CN', 'feed.countActive', { count: 3 }),
    ).toBe('筛选（3 项生效）');
    expect(
      translate('en', 'card.labelTooLong', { max: 40 }),
    ).toBe('Label must be at most 40 characters');
  });

  it('interpolates multiple distinct placeholders', () => {
    expect(
      translate('en', 'feed.removeFilter', { label: 'Unread' }),
    ).toBe('Remove Unread filter');
    expect(
      translate('zh-CN', 'feed.removeFilter', { label: '未读' }),
    ).toBe('移除 未读 筛选');
  });

  it('keeps the raw token visible when a value is missing (bug visibility)', () => {
    expect(translate('en', 'feed.countActive')).toBe('Filters, {count} active');
  });

  it('treats interpolation values as plain text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)> & "quoted"';
    const output = translate('en', 'feed.removeFilter', { label: hostile });

    // The value is embedded verbatim - no escaping, no parsing - and when
    // rendered as React text it stays text: no <img> element is created.
    expect(output).toBe(`Remove ${hostile} filter`);
    const { container } = render(createElement('div', null, output));
    expect(container.textContent).toBe(`Remove ${hostile} filter`);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('resolveBrowserLocale', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['ZH-Hans', 'zh-CN'],
    ['fr-FR', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ])('maps %s to %s', (language, expected) => {
    expect(resolveBrowserLocale(language)).toBe(expected);
  });
});
