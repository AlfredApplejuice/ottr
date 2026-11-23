# Accessibility

## Our commitment

The board targets WCAG 2.1 AA. [DESIGN.md](DESIGN.md#accessibility) carries the rules that the design system enforces:

- Contrast: body text holds at least 4.5:1, and non-text boundaries hold at least 3:1, in the dark theme and the light theme.
- Color never carries a state alone. Every alarm state also has a shape or a text mark.
- Every action works from the keyboard. Native dialogs hold and release focus, and the focus ring stays visible.
- Every icon-only control carries a name for screen readers, and status messages reach them through live regions.
- The layout reflows to a 320 pixel wide viewport and to 200 percent zoom, and all motion honors the reduced-motion setting.

An automated accessibility scan runs before each commit that changes the UI, and a scan runs before a release that touches the UI.

We publish no conformance level. No manual WCAG audit has checked the board, and the automated scans do not replace one.

## Supported environments

Ottr is a web board. It runs on your machine, and you open it in a current desktop or mobile browser. The board offers a dark theme and a light theme, and it renders on screens down to a 320 pixel width, for example on a phone.

## Known limits

- No manual audit has run against the board, so this document names no WCAG conformance level.
- The pictures in the documentation, for example the board screenshot, carry alt text only. A screen reader reads the alt text, not the details in the picture.
- The Mermaid diagrams in [docs/how-it-works.md](docs/how-it-works.md) use the default theme of the Mermaid library. That theme does not follow the contrast rules of the board.

## Report a barrier

When something in the board blocks you, open an issue with the [accessibility report form](https://github.com/ottr-ai/ottr/issues/new?template=accessibility_report.yml). The form sets the `accessibility` label itself, so you need no label permission. Tell us the page, what you did, what you expected, and what happened.
