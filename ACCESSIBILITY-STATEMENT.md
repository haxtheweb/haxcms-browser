# Accessibility Statement — haxtheweb/haxcms-browser

**Last updated:** November 2026  
**Contact:** hax@psu.edu  
**Standard:** WCAG 2.1 AA (with WCAG 2.0 AA baseline)

## Our Commitment

`haxcms-browser` runs HAXcms entirely in a browser tab so anyone can try it with nothing installed. That only helps if everyone can use it. Accessibility is one of the HAX project pillars: **Accessible — built for everyone, by everyone.**

## What is in this repository

What you see when you open the demo comes from two places, and they are tested in different ways.

- **The host page** (`src/site/`): the bar across the top that says whether HAXcms is running and where your sites are saved, the folder buttons, and the Details panel. This repository owns it.
- **The HAX dashboard and editor**, shown in a frame below the bar. These are the same `app-hax` and HAXcms elements every HAX install uses. They come from [`haxtheweb/webcomponents`](https://github.com/haxtheweb/webcomponents) and are not changed here.

## What we do

### The host page

- One page with a banner landmark, a labelled navigation region, a real heading for the Details panel, and native `<button>` controls; nothing needs a pointer.
- Status changes (starting, ready, saved, not saved) are announced through `role="status"` regions, not by color alone; the colored dot is decorative and hidden from assistive technology.
- The Details button states whether its panel is open (`aria-expanded`, `aria-controls`).
- Visible `:focus-visible` outlines, light and dark color schemes that follow the system setting, and a `forced-colors` style for Windows High Contrast.
- No animation or timed content.
- Checked in November 2026 with axe (WCAG 2.0 / 2.1 A and AA rules) in light and dark: no violations on the host page.

### The dashboard and editor

Accessibility of the dashboard, editor, themes and content elements is the work of `haxtheweb/webcomponents`, where every pull request runs axe-based element tests and blocking checks for color contrast in light and dark, forced colors, focus visibility, reflow, target size and reduced motion. See its [accessibility statement](https://github.com/haxtheweb/webcomponents/blob/master/ACCESSIBILITY-STATEMENT.md).

The demo shows whatever build of those elements haxcms-nodejs `main` ships, so a fix made there appears here after the next HAX release build.

## Known Limitations

- **No automated accessibility test runs in this repository yet.** The host page was checked by hand with axe; a regression would not be caught by CI today.
- **The same axe check found two critical issues in the dashboard** (the starter cards were marked up as a grid without rows). They are fixed in `haxtheweb/webcomponents` and reach this demo with the next HAX release build.
- **"Save to a folder" needs the File System Access API**, which only Chromium-based browsers provide. Other browsers save sites in browser storage instead; the bar always says which is in use.
- **Screen reader testing of the host page has not been recorded.** Reports from NVDA, JAWS, VoiceOver and TalkBack users are welcome.

## How You Can Help

- **Report accessibility issues** in the unified issue queue, [haxtheweb/issues](https://github.com/haxtheweb/issues/issues), or email hax@psu.edu.
- **Test with assistive technologies** (screen readers, keyboard-only navigation, high contrast modes) and share what you find.

## Support

- **Email:** hax@psu.edu
- **GitHub:** [haxtheweb/issues](https://github.com/haxtheweb/issues)
- **Discord:** [discord.gg/aCGxmRHEJP](https://discord.gg/aCGxmRHEJP) (#accessibility channel)

---

_This statement reflects our current status and commitments. As an evolving open source project, we acknowledge there is always more work to do to ensure accessibility for all users._
