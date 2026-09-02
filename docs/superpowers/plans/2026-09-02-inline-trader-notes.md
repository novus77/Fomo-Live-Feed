# Inline Trader Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add, view, edit, and clear a private trader note directly beside the trader name without increasing event-card height.

**Architecture:** Reuse `TraderAnnotationV1.label` and the existing annotation persistence callbacks. Add one focused inline editor component, then restructure only the identity header so profile links never contain the interactive note control. Notes remain local, searchable, and keyed by stable `traderId`.

**Tech Stack:** React 19, TypeScript, chrome.storage.local, Vitest, React Testing Library, Playwright

---

### Task 1: Build the inline note editor with keyboard semantics

**Files:**
- Create: `src/sidepanel/InlineTraderNote.tsx`
- Create: `tests/unit/InlineTraderNote.test.tsx`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/i18n-catalog.test.ts`

- [ ] **Step 1: Write failing editor tests**

Cover the empty add state, saved chip, edit mode, selected existing text, Enter save, Escape cancel, blur save, whitespace clear, and a rejected 41-character draft:

```tsx
render(<InlineTraderNote label="Whale" onSave={onSave} />);
fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
const input = screen.getByRole('textbox', { name: 'Trader note' });
fireEvent.change(input, { target: { value: '  Momentum  ' } });
fireEvent.keyDown(input, { key: 'Enter' });
expect(onSave).toHaveBeenCalledWith('Momentum');

fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(41) } });
fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
expect(screen.getByRole('alert')).toHaveTextContent('Note must be at most 40 characters');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/InlineTraderNote.test.tsx
```

Expected: FAIL because `InlineTraderNote.tsx` does not exist.

- [ ] **Step 3: Add localized messages**

Add matching English and Simplified Chinese catalog entries:

```ts
'card.addNote': '＋Note',
'card.editNote': 'Edit trader note: {note}',
'card.traderNote': 'Trader note',
'card.noteTooLong': 'Note must be at most {max} characters',
'card.noteKeyboardHelp': 'Enter to save · Esc to cancel',
```

```ts
'card.addNote': '＋备注',
'card.editNote': '编辑交易员备注：{note}',
'card.traderNote': '交易员备注',
'card.noteTooLong': '备注最多 {max} 个字符',
'card.noteKeyboardHelp': 'Enter 保存 · Esc 取消',
```

Extend `tests/unit/i18n-catalog.test.ts` to assert the parameterized maximum and hostile note interpolation remain text.

- [ ] **Step 4: Implement the focused component**

Use the existing `MAX_ANNOTATION_LABEL_LENGTH` contract and export no new persistence API:

```tsx
export interface InlineTraderNoteProps {
  label: string | undefined;
  onSave(label: string): void;
}

export function InlineTraderNote({ label, onSave }: InlineTraderNoteProps) {
  const { translate } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? '');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (): void => {
    const next = draft.trim();
    if (next.length > MAX_ANNOTATION_LABEL_LENGTH) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setEditing(false);
    onSave(next);
  };

  // When editing is false render a button with either the saved chip or
  // localized add label. When true render the input, keyboard help, and alert.
  // Focus and select the input in a layout effect when editing begins.
}
```

Prevent duplicate blur/Enter commits with a small committed ref or by checking that editing is still active before saving.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/InlineTraderNote.test.tsx tests/unit/i18n-catalog.test.ts
```

Expected: all editor and catalog tests PASS.

Commit:

```bash
git add src/sidepanel/InlineTraderNote.tsx src/i18n/catalog.ts tests/unit/InlineTraderNote.test.tsx tests/unit/i18n-catalog.test.ts
git commit -m "feat: add inline trader note editor"
```

### Task 2: Integrate notes without nesting controls inside profile links

**Files:**
- Modify: `src/popup/EventCard.tsx`
- Modify: `tests/unit/EventCard.test.tsx`

- [ ] **Step 1: Write failing EventCard tests**

Replace the legacy assertion that stored annotations stay hidden with these contracts:

```tsx
expect(screen.getByRole('button', { name: '＋Note' })).toBeInTheDocument();
expect(screen.getByRole('link', { name: /Roaring Kitty/ })).toHaveAttribute(
  'href',
  expect.stringContaining('/profile/'),
);
expect(screen.getByRole('button', { name: '＋Note' }).closest('a')).toBeNull();

renderCard({ annotation: { traderId: event.traderId, label: 'Whale', updatedAt: 1 } });
fireEvent.click(screen.getByRole('button', { name: 'Edit trader note: Whale' }));
fireEvent.change(screen.getByRole('textbox', { name: 'Trader note' }), {
  target: { value: 'Momentum' },
});
fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
expect(onUpsertAnnotation).toHaveBeenCalledWith(event.traderId, {
  label: 'Momentum',
});
```

- [ ] **Step 2: Run EventCard tests and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/EventCard.test.tsx
```

Expected: FAIL because the note control is not rendered.

- [ ] **Step 3: Refactor the identity header and connect persistence**

Import `InlineTraderNote`. Keep the avatar and trader text linked to the verified profile URL, but render the note control as a sibling interactive element in `.event-trader-primary`, never as a descendant of an anchor. Pass:

```tsx
<InlineTraderNote
  label={annotation?.label}
  onSave={(label) => {
    onUpsertAnnotation(event.traderId, { label });
  }}
/>
```

Keep `formatRelativeTime(...)` in the same row after the note control. Do not change token navigation, translation, financial values, or CA copying.

- [ ] **Step 4: Verify EventCard behavior and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/EventCard.test.tsx tests/unit/InlineTraderNote.test.tsx
```

Expected: all tests PASS with no nested interactive-element warnings.

Commit:

```bash
git add src/popup/EventCard.tsx tests/unit/EventCard.test.tsx
git commit -m "feat: show trader notes beside names"
```

### Task 3: Preserve density and expose complete notes safely

**Files:**
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `tests/unit/sidepanel-style-contract.test.ts`

- [ ] **Step 1: Write a failing compact-layout contract**

Assert the primary row remains single-line, the note can shrink, time cannot shrink, and the editor has a bounded width:

```ts
expect(css).toMatch(/\.event-trader-primary\s*\{[^}]*white-space:\s*nowrap/s);
expect(css).toMatch(/\.trader-note-chip\s*\{[^}]*text-overflow:\s*ellipsis/s);
expect(css).toMatch(/\.trader-note-input\s*\{[^}]*max-width:\s*120px/s);
expect(css).toMatch(/\.event-time\s*\{[^}]*flex:\s*none/s);
```

- [ ] **Step 2: Run the style test and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/sidepanel-style-contract.test.ts
```

Expected: FAIL because the new note classes do not exist.

- [ ] **Step 3: Add compact styles**

Add styles equivalent to:

```css
.event-trader-primary { white-space: nowrap; }
.trader-note-add,
.trader-note-chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 104px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trader-note-input { width: 112px; max-width: 120px; min-width: 54px; }
.trader-note-help,
.trader-note-error { position: absolute; }
```

Use existing theme tokens, purple focus treatment, and 18 px controls. Error/help overlays must not reserve a new card row.

- [ ] **Step 4: Verify styles and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/sidepanel-style-contract.test.ts tests/unit/EventCard.test.tsx
```

Expected: all tests PASS.

Commit:

```bash
git add entrypoints/sidepanel/sidepanel.css tests/unit/sidepanel-style-contract.test.ts
git commit -m "style: keep trader notes compact"
```

### Task 4: Verify propagation, search, and browser behavior

**Files:**
- Modify: `tests/unit/SidePanelApp.test.tsx`
- Modify: `tests/unit/event-query.test.ts`
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `docs/manual-testing.zh-CN.md`

- [ ] **Step 1: Add failing integration coverage**

Render two events with the same `traderId`, save one note, resolve the mocked preferences write, and assert both cards expose `Edit trader note: <value>`. In `event-query.test.ts`, assert the saved note continues to match normalized search.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/SidePanelApp.test.tsx tests/unit/event-query.test.ts
```

Expected: the propagation test fails until the inline callback updates shared annotations.

- [ ] **Step 3: Make the smallest propagation correction**

If the current `upsertAnnotation` callback already updates the shared annotation map, keep it unchanged. Otherwise ensure its resolved value replaces the entry by stable `traderId`:

```ts
setAnnotations((previous) => new Map(previous).set(traderId, next));
```

- [ ] **Step 4: Add browser coverage and manual checks**

In Playwright, exercise `＋备注`, Enter save, both-card propagation, edit, Escape cancel, and verify card height remains within the existing density threshold. Document the same workflow in the Chinese manual guide.

- [ ] **Step 5: Run full verification and commit**

Run:

```bash
git diff --check
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit
/usr/local/bin/node node_modules/vitest/vitest.mjs run
/usr/local/bin/node node_modules/wxt/bin/wxt.mjs build
/usr/local/bin/node node_modules/@playwright/test/cli.js test tests/e2e/live-feed.spec.ts
```

Expected: typecheck, all unit/integration tests, production build, and all browser scenarios PASS.

Commit:

```bash
git add tests/unit/SidePanelApp.test.tsx tests/unit/event-query.test.ts tests/e2e/live-feed.spec.ts docs/manual-testing.zh-CN.md
git commit -m "test: verify inline trader notes"
```
