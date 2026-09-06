# Dashboard visual direction

Design Read: internal operator dashboard for WhatsApp gateway administrators, in a calm local-operations visual language, with ENERGY 1, RHYTHM 2, and MOTION 1.

## Liveliness dials

- ENERGY 1: calm monitoring surface; color appears only for state, action, and attention.
- RHYTHM 2: predictable dashboard scanning with limited hierarchy breaks between status, evidence, and navigation.
- MOTION 1: immediate utility feedback only; no decorative loops or stacked transitions.

## Decision purposes

- Palette: dark local-operations surfaces reduce glare; green marks safe primary actions and connected state; amber and red are reserved for attention.
- Typography: Inter and system sans keep dense operational data readable; monospace is limited to identifiers, timestamps, filenames, and checksums.
- Spacing: the 4, 5, and 6 spacing rhythm supports monitoring density while preserving 44px touch targets and readable groups.
- Cards: cards group related operational evidence; elevation is reserved for modal or raised surfaces, never every panel.
- Iconography: Lucide line icons provide quick category anchors and always appear with text or an accessible name when interactive.
- Motion: hover, focus, loading, and state transitions confirm behavior without delaying work.
- Background: dashboard and authentication surfaces stay plain; generic grids and decorative page glows are intentionally omitted.
- Shadow: base cards are flat; the panel shadow is reserved for modal elevation.
- Glow: primary actions use color and focus rings, not glow.
- Blur: persistent dashboard chrome stays solid; blur is not stacked across navigation, headers, and content.
- Card hierarchy: status and health come first, operational evidence second, navigation and guidance third.

## Component rules

- Interactive targets are at least 44 by 44 CSS pixels.
- Icon-only controls require an accessible name and visible focus ring.
- Normal text contrast must be at least 4.5:1; large text and functional boundaries must be at least 3:1.
- Empty, loading, error, and success states include explanatory text.
- Mobile drawers must leave the tab order when closed, focus their close control when opened, close on Escape, and return focus to the opener.
- At 200% zoom, public and authenticated layouts must not clip content or force page-level horizontal scrolling.
