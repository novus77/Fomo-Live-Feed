# Developer Support Panel Design

## Goal

Add a localized developer-support entry to the Side Panel without changing the
extension's existing wallet-safety or informational-only boundaries. Users can
copy the developer's BSC or Solana address, read how sponsorship supports the
project, and contact the developer about joining a technical co-creation group.

## Current Context

The extension MVP, Side Panel feed, English/Simplified Chinese localization,
light/dark themes, settings panel, address-copy interaction, and automated test
coverage are already implemented. The production Fomo enrichment and REST
backfill adapters remain disabled pending authenticated and redacted evidence;
this feature does not depend on either adapter.

The Side Panel header currently contains Refresh followed by Settings. Settings
opens a large inline panel in the Side Panel rather than a modal overlay.

## Scope

### Header entry

- Add a developer-support button after Settings, making the visible order:
  Refresh, Settings, Support.
- Render a local heart or gift SVG icon followed by a localized label:
  `打赏` in Simplified Chinese and `Support` in English.
- Give the button a localized accessible name, `title`, visible focus state,
  and `aria-expanded` state.
- Use a restrained accent treatment that distinguishes Support from the two
  utility controls without making it look like a primary trading action.

### Inline panel behavior

- Open the support content as a large inline panel using the same presentation
  model as Settings. Do not use a popover, centered modal, or separate page.
- Settings and Support are mutually exclusive. The panel state has exactly
  three possibilities: neither panel open, Settings open, or Support open.
- Clicking Support while Settings is open closes Settings and opens Support.
  Clicking Settings while Support is open closes Support and opens Settings.
- Clicking the active header button closes its panel.
- The support panel must remain usable at the Side Panel's existing minimum
  width and in both light and dark themes.

## Support Panel Content

Create a focused `SupportPanel` component rather than adding the complete
surface directly to `SidePanelApp`.

### Developer support section

The first section contains:

- Heading: `支持开发者`
- Body: `感谢老板支持，你的赞助会帮助我维护和改进插件。`
- One BSC address row:
  `0x373709fdbdcf272cba93164c7d0e3b87b88a1b02`
- One Solana address row:
  `4NrMQRjLde48FSm52UDdn2EgAvd1z7TraXpX1S44L9rj`
- A localized Copy button next to each address.

Addresses are rendered in a monospace style, remain fully visible, and wrap at
arbitrary character boundaries when necessary. They must never be shortened in
the actual UI. Each Copy button writes only its associated address.

### Technical co-creation group

Render this section inside a visually distinct bordered container. The border,
background, and heading establish hierarchy while retaining readable contrast
in both themes.

The confirmed Simplified Chinese copy is:

> ### 开发共创小群
>
> 单笔赞助价值超过 **$100**，请将转账地址和交易哈希私信
> [@XXten177](https://t.me/XXten177)。确认后，我会邀请你加入技术开发小群。
>
> 大家的赞助将用于支持插件的持续维护和后续开发。
>
> 加入小群后，你可以：
>
> - **参与插件优化讨论**  
>   提出功能建议并参与投票。获得较多用户支持的需求，我会结合可行性和开发成本，优先纳入后续更新计划。
> - **讨论共性定制需求**  
>   如果某项需求具有较高的普遍性，并且有较多用户需要，我会评估将其开发为插件功能。
> - **优先体验新插件**  
>   有机会优先体验我后续开发的其他插件和早期版本，并参与反馈与改进。

The English catalog must preserve the same boundaries: group participation is
an opportunity to discuss and prioritize broadly useful work, not a guarantee
of individual custom development.

`@XXten177` is the visible link text and opens
`https://t.me/XXten177` in a new tab through the Side Panel's existing safe
external-link boundary.

## Component and State Design

### `SidePanelApp`

Replace the independent `showSettings` boolean with one panel discriminator,
for example:

```ts
type OpenUtilityPanel = 'settings' | 'support' | null;
```

`SidePanelApp` owns this state because it coordinates the two header buttons
and decides which inline panel is mounted. Existing settings persistence and
diagnostics behavior remain unchanged. Pipeline diagnostics continue to render
with Settings and do not appear under Support.

### `SupportPanel`

`SupportPanel` owns presentation only. It receives injected operations rather
than reading browser globals directly:

```ts
interface SupportPanelProps {
  copyText(text: string): Promise<void>;
  openLink(url: URL): void;
}
```

Static wallet addresses and the Telegram URL live in the support component or
a small adjacent constants module. No address enters storage, messaging, or the
service worker.

The component keeps bounded local copy-feedback state per address. Reusing the
existing injected `copyText` and `openLink` boundaries keeps the component
unit-testable and consistent with address-copy and navigation behavior already
used by event cards.

## Copy Feedback and Errors

- After a successful copy, the relevant button temporarily displays the
  localized equivalent of `Copied`.
- The other address row remains unaffected.
- If clipboard writing fails, show a localized, non-blocking `Copy failed`
  message on the relevant row and keep the complete address visible for manual
  selection.
- A later copy attempt replaces the previous state; failure never closes the
  panel.
- Telegram navigation uses the existing `openLink` injection. No user content
  is interpolated into the URL.
- There is no wallet connection, chain query, transaction verification,
  sponsorship record, analytics event, or background message for this feature.

## Localization

Add all visible and accessible strings to the existing typed English and
Simplified Chinese catalogs. This includes:

- Support header button label and title.
- Support panel heading and thank-you message.
- Chain/address accessibility labels.
- Copy, copied, and copy-failed states if existing generic keys are not
  semantically reusable.
- Co-creation group heading, qualification instructions, sponsorship-purpose
  sentence, three benefit headings, and three benefit descriptions.

The UI follows the extension's selected UI locale, which already defaults from
the browser locale on first use and can be changed in Settings. Wallet
addresses, `$100`, `@XXten177`, and the Telegram URL are locale-independent.

## Styling and Accessibility

- Follow existing Side Panel spacing, typography, border radius, focus-ring,
  and theme conventions.
- The Support button uses an inline SVG with `aria-hidden="true"`; its text and
  button label provide the accessible name.
- The support panel is a labeled region with a semantic heading hierarchy.
- Benefit content uses a semantic list.
- Copy controls are real buttons with address-specific accessible names.
- The Telegram username is a real link or link-equivalent control exposed
  through the existing safe navigation boundary.
- Full addresses remain selectable text even when clipboard access fails.
- Do not rely on purple, borders, or icons alone to communicate meaning.
- Opening the inline panel does not require focus trapping. Keyboard order
  follows DOM order from the header controls into the panel content.

## Verification

### Unit tests

- Header controls render in Refresh, Settings, Support order.
- Support button label follows the active UI locale.
- Support toggles open and closed.
- Opening Support closes Settings; opening Settings closes Support.
- Pipeline diagnostics remain scoped to Settings.
- Both complete wallet addresses render without truncation.
- Each Copy button sends exactly its associated address.
- Success and failure feedback are row-specific and localized.
- Telegram displays `@XXten177` and opens the exact HTTPS URL.
- The confirmed Chinese content and semantically equivalent English content
  render from typed catalog keys.
- Support panel semantics and accessible names are present.

### Styling and integration checks

- Light and dark theme selectors cover the Support button, panel surfaces,
  address rows, bordered co-creation section, secondary text, and focus states.
- The minimum supported Side Panel width wraps both addresses without
  horizontal overflow.
- Existing Settings, Refresh, feed, translation, and theme tests continue to
  pass.
- Run the normal release gate:

```bash
CI=true corepack pnpm check
```

- Run the existing end-to-end suite when the implementation changes the
  Side Panel composition:

```bash
CI=true corepack pnpm test:e2e
```

## Privacy and Security Boundaries

- The extension displays public recipient addresses only.
- It never requests a seed phrase, private key, wallet connection, signature,
  token approval, or login credential.
- It never observes, verifies, or stores transactions or sponsorship amounts.
- Users provide transfer details to the developer manually through Telegram.
- The feature adds no host permission, extension permission, network request,
  storage schema, or service-worker responsibility.

## Non-goals

- Connecting a wallet or initiating a transfer.
- Generating QR codes or chain-specific payment links.
- Monitoring BSC or Solana transactions.
- Automatically converting assets to USD or enforcing the `$100` threshold.
- Automatically granting group access.
- Promising individual custom development.
- Changing feed capture, enrichment, recovery, translation, settings
  persistence, or trading-page toast behavior.
