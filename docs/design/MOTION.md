# Motion

What moves in Peers, and how. PRODUCT.md §10.5 sets the rules: nothing pops, fades take at least
150 ms on `cubic-bezier(0.25, 0.1, 0.25, 1)` (`--ease`), tab switches are instant, and Reduce
Motion turns travel into a short fade. Each entry below is what the code and the checks follow.

```yaml
id: banner.demo
trigger: the × on the demo notice
mechanism: css-transition on .banner (grid-template-rows 1fr -> 0fr)
elements:
  banner: {from: {rows: 1fr}, to: {rows: 0fr}, ms: 220, ease: --ease}   # opaque; content clipped as it folds
  panes:  {follow: banner}                                               # they move up with the fold, never jump
ready: nothing loads; the notice is already on screen
interrupt: none (one way: it does not come back)
removed: on transitionend, by setting demoHidden; never on a timer
reduced_motion: opacity 1 -> 0, 150 ms, then the panes take the space at once
never:
  - the panes jump up before the fold ends
  - the notice is removed while any of it shows
```

```yaml
id: toast
trigger: a confirmation or error (showToast)
mechanism: css-transition; @starting-style for the entrance, .out for the exit
elements:
  toast: {from: {alpha: 0, y: 8px}, to: {alpha: 1, y: 0}, ms: 200, ease: --ease}
  exit:  {to: {alpha: 0, y: 6px}, ms: 160, ease: --ease}
choreography: newest at the bottom of a bottom-anchored stack, so older toasts do not move when one enters
limits: at most three; a fourth sends the oldest out
interrupt: a toast already leaving is not brought back
removed: on transitionend; the 3.5 s (6 s error, 7 s with an action) timer only starts the exit
reduced_motion: opacity only, 150 ms
never:
  - removed while visible
  - two toasts overlapping
```

```yaml
id: content.enter
trigger: a page, Today, Settings or an agent's settings becomes ready for a new route
mechanism: one-shot css animation (.enter on the first child of the page scroller)
elements:
  content: {from: {alpha: 0, y: 4px}, to: {alpha: 1, y: 0}, ms: 180, ease: --ease}
ready: the page's data has arrived; before that a placeholder the size of a page shows, never the previous page
interrupt: a new route replaces the content; the next one fades on its own
never:
  - fades again on a live update of the same route
  - a cross-fade of two pages (only the new one fades in, over the plain background)
  - app pages (their frame loads on its own)
reduced_motion: opacity only, 150 ms
```

```yaml
id: popover, menu, palette, modal
trigger: open
mechanism: css animation pop-in
elements:
  surface: {from: {alpha: 0, scale: 0.98}, to: {alpha: 1, scale: 1}, ms: 160 (menus 140), ease: --ease-out}
reduced_motion: opacity only, 150 ms
```

```yaml
id: working, skeleton
mechanism: css animation pulse (opacity 1 -> 0.35 -> 1, 1.6 s loop)
reduced_motion: none (static)
```
