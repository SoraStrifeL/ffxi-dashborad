# Responsive App Shell

## Problem

The app shell (`AppShell.tsx` + `Sidebar.tsx`) has a fixed 200px sidebar with no
responsive behavior. On tablet or phone widths the layout breaks — there's no
way to collapse or hide the sidebar to reclaim content width.

## Scope

Shell only: `AppShell.tsx`, `Sidebar.tsx`, and their supporting hook/config.
Individual page content (Dashboard, Database, Map, etc.) is unchanged — this
is purely about the sidebar + surrounding frame that wraps every page via
`<Outlet/>`.

## Breakpoints

Tracked via a new `useBreakpoint()` hook (`client/src/hooks/useBreakpoint.ts`),
resolving `window.innerWidth` to one of three modes. Uses `matchMedia` +
`resize` listener, no polling.

| Mode      | Width range   |
|-----------|---------------|
| `desktop` | ≥ 1024px      |
| `tablet`  | 768px–1023px  |
| `phone`   | < 768px       |

These match Tailwind's conventional `lg`/`md` thresholds for consistency,
even though this codebase drives layout from TS state rather than CSS media
queries (see Approach below).

## Shared nav config

`NAV` and `ADMIN_NAV` arrays move out of `Sidebar.tsx` into a new
`client/src/navConfig.ts`, alongside a new `getPageTitle(pathname): string`
helper that matches the current route to its label (longest `to` prefix
match; falls back to `'Dashboard'`). Both `Sidebar.tsx` and `AppShell.tsx`
import from this shared file — `AppShell` needs the title for the phone
top bar, `Sidebar` keeps using the arrays to render links. This is a pure
extraction; the array contents and filtering-by-permission logic are
unchanged.

## Sidebar variants

`Sidebar` gains a `variant: 'full' | 'rail' | 'drawer'` prop, and for
`variant="drawer"` only, `open: boolean` and `onClose: () => void`.

- **`full`** (desktop): today's sidebar, unchanged — 200px, always mounted
  inline in the flex row.
- **`rail`** (tablet): width shrinks to 56px. Brand text, section headers,
  nav labels, the user's name/tier text, and the version footer text all
  collapse away — icons only, centered. Each nav link gets a native `title`
  attribute carrying its label (tooltip on hover, since there's no room for
  visible text). The avatar circle stays; logout becomes an icon-only button.
- **`drawer`** (phone): not part of the inline flex row. Rendered as a
  `position: fixed` panel (same full-label layout as `full`) at
  `left:0; top:0; bottom:0`, `transform: translateX(open ? 0 : -100%)`,
  `transition: transform .2s ease`, elevated `z-index`. A semi-transparent
  fixed backdrop covers the rest of the viewport when `open`, and clicking it
  calls `onClose`. Every nav link click also calls `onClose` (an `onNavigate`
  callback passed down from `AppShell`, invoked in each link's `onClick`), so
  navigating closes the drawer. An `Escape` keydown listener (active only
  while `open`) also closes it.

## AppShell changes

- Calls `useBreakpoint()`. Holds `drawerOpen` state, meaningful only in phone
  mode; resets to `false` whenever the resolved breakpoint changes (so
  resizing back down to phone never shows a stale open drawer).
- `desktop` / `tablet`: renders exactly as today —
  `<Sidebar variant={...} /> <main><Outlet/></main>`, no top bar.
- `phone`: renders a new slim top bar (~48px tall, `var(--color-surface)`
  background, border matching the sidebar's) above `<Outlet/>`: a hamburger
  button on the left (opens the drawer) and `getPageTitle(pathname)` as the
  title. `<Sidebar variant="drawer" open={drawerOpen} onClose={...} />` is
  rendered alongside — fixed-position, so it doesn't participate in the flex
  layout.
- Per-page padding/content (e.g. Dashboard's `24px 28px` wrapper) is
  untouched — out of scope.

## Approach (why JS-driven, not CSS breakpoints)

Considered driving this with Tailwind responsive classes (`hidden md:flex`,
etc.) instead. Rejected: `Sidebar.tsx`/`AppShell.tsx` are 100% inline-style
today, matching the rest of this codebase's convention of keeping layout
logic in TS rather than CSS. Converting just these two files to Tailwind
classes for this one feature would be a bigger, inconsistent diff than
adding one small hook. A JS breakpoint hook keeps the change localized and
easy to reason about — the entire layout mode is one hook's return value.

## Edge cases

- Breakpoint changes while the drawer is open (e.g. rotating a tablet, or
  resizing a desktop browser window down through phone width) force-close it
  via the reset described above.
- `CharacterDetail` and other nested pages render inside the same
  `<Outlet/>` as top-level pages, so they automatically get the phone top
  bar with no per-page changes needed.
- No changes to the existing auth/WS-token-refresh effects in `AppShell` —
  this is purely additive layout state alongside them.

## Out of scope

- Individual page content/padding responsiveness (Dashboard, Database, Map,
  etc.) — separate concern, not addressed here.
- Manual desktop sidebar collapse toggle — not requested; desktop keeps the
  full sidebar always.
- Bottom tab bar / alternate phone nav patterns — hamburger + drawer was
  chosen over these.
