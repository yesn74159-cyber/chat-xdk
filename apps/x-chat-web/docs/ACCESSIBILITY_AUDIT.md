# Accessibility audit — local prototype

Scope: `public/index.html` + `public/app.js` in Mock mode, verified on
2026-11-21 with desktop Chrome. This is a static/code audit plus a keyboard and
focus smoke test, not a full WCAG conformance review.

## Verified

| Check                               | Evidence                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page language                       | `<html lang="th">`                                                                                                                                                                                                                          |
| Form controls have accessible names | All 17 `input`/`textarea`/`select` elements are named by `for=` or by a wrapping `<label>`; the three consent checkboxes (`contact-start-consent`, `contact-live-consent`, `contact-live-final-approval`) are wrapped in `<label>` elements |
| Icon buttons are named              | Settings toggle and close, new-chat close: `aria-label` present; dialogs use `aria-labelledby`                                                                                                                                              |
| Modal semantics                     | Both dialogs open with `showModal()`, which makes them modal and restores focus to the opener on close; the settings dialog focuses its close button on open (confirmed in the accessibility tree)                                          |
| Status announcements                | `#pin-account`, `#unlock-status`, `#send-state`, `#contact-lookup-status`, `#activity` use `role="status"` + `aria-live="polite"`; message list and contact results are polite live regions                                                 |
| Toggle state                        | Conversation filter chips expose `aria-pressed`                                                                                                                                                                                             |
| Keyboard paths                      | All actions are native `<button>`/`<input>`/`<summary>`/form submit; Escape closes the new-chat dialog unless a create is in progress (`cancel` handler)                                                                                    |
| Errors are announced                | Send/unlock/cache errors write into live-region status elements in Thai                                                                                                                                                                     |
| No console errors                   | Loading the built app in Mock mode produced no console messages                                                                                                                                                                             |
| Text contrast                       | `npm run check:contrast` asserts 45 real foreground/background pairs from `public/style.css` at WCAG AA (4.5:1 small text, 3:1 large); it runs inside `npm run check`                                                                       |
| Reduced motion                      | `@media (prefers-reduced-motion: reduce)` disables transitions, scroll behaviour, and animations                                                                                                                                            |
| Focus indicator                     | `:focus-visible` outline (`2px solid #60a5fa`, offset 3px) on every interactive element; keyboard smoke test reached the settings dialog and filter chips                                                                                   |

## Not verified

- **Screen reader walkthrough** — needs NVDA or VoiceOver on a real run,
  including the send-state transitions and the image attachment flow.
- **Zoom / reflow** at 200% and small viewports. The layout has 900px/600px
  breakpoints and a 320px `min-width`, but no automated reflow assertion yet.
- **Rendered contrast of every transient state** — the static guard covers the
  declared colour pairs; a visual pass over hover/disabled/error states is still
  worthwhile when a real browser session is available.
- **Browser matrix** — only Chrome was exercised; see the supported-browser
  note in the README. Firefox and Safari remain unsupported until tested.

## Notes for the next pass

- The composer is disabled until a conversation is open; verify the disabled
  state remains discoverable to screen readers once the composer gains hints.
- Unverified events render as placeholders; confirm their text is announced when
  history refresh adds them.
