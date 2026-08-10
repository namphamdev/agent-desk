# Agent Debug Inspector

A built-in element inspector for the GPUI app. Click the magnifier icon in the
bottom-right corner to enter **pick mode**, then hover any tagged UI element to
see its source file, line number, and module path. Click to freeze the selection
and copy the location to your clipboard for pasting into an AI agent prompt.

## Why it exists

GPUI has no DOM, no devtools, and no `element_at_point()` API. When an agent
needs to modify a specific UI element, there is no easy way to point it at the
right file and line. This inspector closes that gap: point at the screen, get
the exact source location, hand it to the agent.

## Activation

| Condition | Active? |
|---|---|
| Debug build (`cargo run`) | Yes, always |
| Release build | No, unless `COMET_INSPECTOR=1` env var is set |
| Release build without env var | No (zero cost, all tag calls compile away) |

```
# Force-enable in release:
COMET_INSPECTOR=1 ./comet
```

## Usage

1. Click the magnifier icon in the bottom-right corner of the app window.
   The icon turns accent-colored and a small dot appears on it.
2. Move your mouse over any tagged element. An info panel appears showing:
   - **Element label** (developer-assigned name)
   - **File** (e.g. `crates/ui/src/shell/tabs.rs:367`)
   - **Module** (e.g. `comet_ui::shell::tabs`)
3. Click the element to freeze the selection.
4. Click **"Copy for Agent"** to copy the full metadata to your clipboard.
5. Click the magnifier icon again to exit pick mode.

The copied text looks like:
```
Element: session-tab
File:    crates/ui/src/shell/tabs.rs:367
Module:  comet_ui::shell::tabs
```

## How to tag elements

There are three APIs depending on the element's structure. The key rule:
**GPUI only allows one `on_hover` per element.** If an element already has
`on_hover`, you must use the merge pattern, not `.inspect_tag()`.

### 1. Simple elements (no existing `on_hover`)

For elements built from `div().id(...)` that do NOT already call `.on_hover()`:

```rust
use crate::dev_inspector::InspectExt as _;

div()
    .id("my-button")
    .inspect_tag("my-button")    // adds on_hover + on_mouse_down
    .on_click(/* ... */)
```

This is the easiest pattern. Use it for:
- Buttons with only `.hover(|s| ...)` (Styled-based, not event-based)
- Buttons with only `.on_click()` and no `.on_hover()`

### 2. Elements with existing `on_hover` (merge pattern)

For elements that already call `.on_hover(...)` (e.g. for hover fade animations):

```rust
use crate::dev_inspector::{self, InspectClickExt as _};

let tag = dev_inspector::inspect_meta("my-button");
let hover_tag = tag.clone();

div()
    .id("my-button")
    .on_hover(move |hovered: &bool, window: &mut Window, cx: &mut App| {
        motion::hover_listener("fade-key")(&hovered, window, cx);
        dev_inspector::report_hover(&hover_tag, *hovered, window, cx);
    })
    .inspect_click(tag)          // adds on_mouse_down only (no second on_hover)
    .on_click(/* ... */)
```

Use this for:
- Elements with `motion::hover_listener()` calls
- Elements with custom `on_hover` closures
- The `window_control_button()` and `header_icon_button()` helpers in `render_fns.rs`

### 3. Elements from `popover::menu_row` / `btn_ghost`

`popover::menu_row()` and `popover::btn_ghost()` already call `.on_hover()`
internally. You cannot use `.inspect_tag()` on their output. Use only
`.inspect_click()` (click-to-select without hover reporting):

```rust
use crate::dev_inspector::{self, InspectClickExt as _};

popover::menu_row(&theme, false, format!("my-row-{id}"))
    .id("my-row")
    .inspect_click(dev_inspector::inspect_meta("my-row"))
    .on_click(/* ... */)
```

These elements will still be selectable via click in pick mode, but won't show
hover highlighting.

## API reference

### `inspect_meta(label) -> InspectTag`

Creates a tag at the call site. Uses `#[track_caller]` so `file!()` / `line!()`
resolve to the caller automatically.

```rust
let tag = dev_inspector::inspect_meta("chat-bubble");
// tag.meta.file = "crates/ui/src/transcript/impl_rows.rs"
// tag.meta.line = 142
// tag.meta.module = "comet_ui::transcript::impl_rows"
// tag.meta.label = "chat-bubble"
```

### `report_hover(tag, hovered, window, cx)`

Reports a hover event to the inspector. Call from inside an existing `on_hover`
closure. No-op when the feature is disabled or pick mode is off.

### `select_handler(tag) -> closure`

Returns a `Fn(&MouseDownEvent, &mut Window, &mut App)` for click-to-select.
Used internally by `inspect_click`.

### `.inspect_tag(label)` (trait `InspectExt`)

Convenience method on `Stateful<Div>`. Adds both `on_hover` (hover reporting)
and `on_mouse_down` (click-to-select). **Panics if the element already has
`on_hover`.**

### `.inspect_click(tag)` (trait `InspectClickExt`)

Adds only `on_mouse_down` (click-to-select). Safe to use on elements that
already have `on_hover`.

## Architecture

```
User clicks magnifier icon
    │
    ▼
InspectorState (gpui Global) ── picking = true
    │
    ▼
User hovers a tagged element
    │
    ▼
Element's on_hover closure fires
    │── calls report_hover() ──► InspectorState.snapshot.hovered = Some(meta)
    │── calls window.refresh()
    │
    ▼
Shell::render reads InspectorState.snapshot
    │── renders info panel with element metadata
    │
    ▼
User clicks the element
    │
    ▼
Element's on_mouse_down closure fires
    │── calls select() ──► InspectorState.snapshot.selected = Some(meta)
    │── calls window.refresh()
    │
    ▼
Info panel shows "Copy for Agent" button
```

### State management

`InspectorState` is a gpui `Global` stored as `Rc<RefCell<InspectorInner>>`.
It holds:
- `picking: bool` — whether pick mode is active
- `snapshot.hovered: Option<ElementMeta>` — element under the cursor
- `snapshot.selected: Option<ElementMeta>` — frozen selection from a click

Initialized once in `Shell::new` via `dev_inspector::init(cx)`.

### Source path resolution

`inspect_meta()` is `#[track_caller]`, so `std::panic::Location::caller()`
returns the file and line of the **caller**, not the `dev_inspector` module.
This means the metadata always points to the real component code, not the
inspector internals.

The `file` field is workspace-relative (e.g. `crates/ui/src/shell/tabs.rs`),
matching what `file!()` produces with the workspace's `--remap-path-prefix`
configuration.

## Currently tagged elements

All interactive elements (anything with `.id(...)`) across the UI crate are
tagged. Here is the full list organized by area:

### Shell chrome
| Label | File | Element |
|---|---|---|
| `toggle-sidebar`, `nav-back`, `nav-forward` | `render_fns.rs` | Titlebar cluster buttons |
| Various header button ids | `render_fns.rs` | Header icon buttons (terminal, changes, etc.) |

### Tab strip
| Label | File | Element |
|---|---|---|
| `session-tab` | `tabs.rs` | Session tab |
| `session-tab-close` | `tabs.rs` | Tab close button |
| `new-session-tab` | `tabs.rs` | New session "+" button |
| `tab-prev-arrow`, `tab-next-arrow` | `tabs.rs` | Tab navigation arrows |
| `review-session-button` | `tabs.rs` | Review session button |

### Sidebar
| Label | File | Element |
|---|---|---|
| `sidebar-space-row` | `spaces.rs` | Space row |
| `sidebar-chat-row` | `shell_render_sidebar.rs` | Chat row |
| `settings-nav-item` | `shell_render_sidebar.rs` | Settings nav item |
| `add-space-button` | `spaces.rs` | Add space button |
| `add-space-ghost` | `spaces.rs` | Empty-state add space |

### Gate
| Label | File | Element |
|---|---|---|
| `sign-in-button` | `shell_render_gate.rs` | Sign in |
| `retry-engine-button` | `shell_render_gate.rs` | Retry engine |
| `orgs-retry-button` | `shell_render_gate.rs` | Org retry |
| `org-row` | `shell_render_gate.rs` | Org selection row |
| `create-org-button` | `shell_render_gate.rs` | Create org |
| `org-signout-button` | `shell_render_gate.rs` | Org sign out |

### Main overlays
| Label | File | Element |
|---|---|---|
| `chat-menu-rename/archive/settle/delete` | `shell_render_main.rs` | Chat context menu |
| `rename-chat-cancel/save` | `shell_render_main.rs` | Rename dialog buttons |
| `delete-chat-cancel/confirm` | `shell_render_main.rs` | Delete dialog buttons |
| `onboarding-add-space` | `shell_render_main.rs` | Onboarding CTA |
| `jump-to-bottom` | `shell_render_main.rs` | Jump to bottom pill |

### Activity sidebar
| Label | File | Element |
|---|---|---|
| `sidebar-activity-toggle` | `shell_render_activity.rs` | Activity toggle |
| `sidebar-lists` | `shell_render_activity.rs` | Sidebar lists container |
| `sidebar-notice` | `shell_render_activity.rs` | Error strip |
| `update-strip` | `shell_render_activity.rs` | Update notification |
| `user-menu` | `shell_render_activity.rs` | User menu trigger |
| `user-menu-settings/signout` | `shell_render_activity.rs` | User menu items |

### Composer
| Label | File | Element |
|---|---|---|
| `composer-attach` | `composer_render.rs` | Attachment area |
| `composer-failure` | `composer_render.rs` | Failure message |
| `composer-send-button` | `composer_wizard.rs` | Send button |
| `composer-stop-button` | `composer_wizard.rs` | Stop button |
| `wizard-option` | `composer_wizard.rs` | Wizard option |
| `question-panel` | `composer_wizard.rs` | Question panel |
| `wizard-back/submit` | `composer_wizard.rs` | Wizard navigation |

### Transcript
| Label | File | Element |
|---|---|---|
| `message-row` | `impl_rows.rs` | Message row |
| `message-copy` | `impl_rows.rs` | Copy message button |
| `message-new-thread` | `impl_rows.rs` | New thread button |
| `tool-group-header` | `impl_rows.rs` | Tool group header |
| `error-copy` | `impl_rows.rs` | Error copy button |
| `transcript-scrollbar-track/thumb` | `impl_scroll.rs` | Scrollbar |

### Terminal
| Label | File | Element |
|---|---|---|
| `terminal-tab` | `panel.rs` | Terminal tab |
| `terminal-tab-close` | `panel.rs` | Terminal tab close |
| `terminal-new-tab` | `panel.rs` | New terminal tab |
| `terminal-collapse` | `panel.rs` | Collapse terminal |
| `terminal-tab-bar` | `panel.rs` | Tab bar container |
| `terminal-body` | `panel.rs` | Terminal body |

### Changes pane

The changes panel spans five source files. Below is every interactive element
(button, dropdown, clickable row, context-menu item), grouped by source file.

**Diff detail & file headers** (`render_file.rs`, `mod.rs`)
| Label | File | Element |
|---|---|---|
| `git-selected-file-diff` | `mod.rs` | Selected file diff detail view |
| `file-hdr-{ix}` | `render_file.rs` | File section header (collapse/expand toggle) |

**Git status panel** (`render_status.rs`)
| Label | File | Element |
|---|---|---|
| `git-status-panel` | `render_status.rs` | Status panel container |
| `git-change-list` | `render_status.rs` | File-list container |
| `git-staged-files` / `git-changes-files` | `render_status.rs` | Staged / Changes scrollable file list |
| `git-staged-all` / `git-changes-all` | `render_status.rs` | Stage all / Unstage all button |
| `git-staged-selected` / `git-changes-selected` | `render_status.rs` | Stage selected / Unstage selected button |
| `git-file-Staged-{ix}` / `git-file-Changes-{ix}` | `render_status.rs` | File row (selects diff detail) |
| `git-check-Staged-{ix}` / `git-check-Changes-{ix}` | `render_status.rs` | File selection checkbox |
| `git-file-action-Staged-{ix}` / `git-file-action-Changes-{ix}` | `render_status.rs` | Per-file stage/unstage action |
| `git-refresh` | `render_status.rs` | Refresh button |
| `git-fetch` | `render_status.rs` | Fetch button |
| `git-push` | `render_status.rs` | Push button |

**Commit form** (`render_form.rs`)
| Label | File | Element |
|---|---|---|
| `git-harness-select` | `render_form.rs` | Client (harness) dropdown trigger |
| `git-harness-popover` | `render_form.rs` | Client picker popover menu |
| `git-harness-list` | `render_form.rs` | Client picker scrollable list |
| `git-harness-{ix}` | `render_form.rs` | Client picker row |
| `git-model-select` | `render_form.rs` | Model dropdown trigger |
| `git-model-popover` | `render_form.rs` | Model picker popover menu |
| `git-model-list` | `render_form.rs` | Model picker scrollable list |
| `git-model-{ix}` | `render_form.rs` | Model picker row |
| `git-generate-message` | `render_form.rs` | AI message generate button |
| `git-commit` | `render_form.rs` | Commit staged changes button |

**Right-click file context menu** (`render_form.rs`)
| Label | File | Element |
|---|---|---|
| `git-file-context-menu` | `render_form.rs` | Context menu popover |
| `git-menu-discard-{path}` | `render_form.rs` | Discard changes |
| `git-menu-ignore-{path}` | `render_form.rs` | Ignore file |
| `git-menu-copy-path-{path}` | `render_form.rs` | Copy file path |
| `git-menu-copy-relative-{path}` | `render_form.rs` | Copy relative file path |
| `git-menu-reveal-{path}` | `render_form.rs` | Reveal in Finder |

### Pickers
| Label | File | Element |
|---|---|---|
| `trigger_chip` / `footer_chip` | `render_chips.rs` | Picker chips |
| `harness-tab` | `render_model.rs` | Harness tab |
| `model-row` | `render_model.rs` | Model selection row |
| `reasoning-row` | `render_model.rs` | Reasoning level |
| `trait-choice` | `render_model.rs` | Trait choice |
| `branch-row` | `render_popovers.rs` | Branch selector |
| `checkout-row` | `render_popovers.rs` | Checkout selector |
| `permission-row` | `render_popovers.rs` | Permission row |

### Markdown
| Label | File | Element |
|---|---|---|
| `code-copy` | `code.rs` | Code block copy |
| `code-scroll` | `code.rs` | Code block scroll |
| `mermaid-copy/expand/zoom` | `mermaid.rs` | Mermaid controls |

### Settings (9 files)
| Label | File | Element |
|---|---|---|
| `device-rename/delete/id` | `devices.rs` | Device management |
| `activate/edit/remove/install-acp` | `acp_agents.rs` | ACP agent management |
| `unarchive` | `archived.rs` | Unarchive session |
| Various provider/shortcut/workflow rows | Respective files | Configuration rows |

### Other
| Label | File | Element |
|---|---|---|
| `rail-tick` | `rail.rs` | Message rail indicator |

## File layout

```
crates/ui/src/
├── dev_inspector.rs              # Core: state, APIs, traits
├── shell/
│   ├── shell_render_inspector.rs # Overlay UI: trigger icon + info panel
│   ├── shell_core.rs             # init() call in Shell::new
│   └── mod.rs                    # Overlay render call in Shell::render
```

## Troubleshooting

### Keyboard shortcut

In an enabled build, press **Cmd/Ctrl+Shift+I** to toggle pick mode. This is
equivalent to clicking the inspector trigger icon.

### "calling on_hover more than once on the same element is not supported"

This panic means an element has two `on_hover` calls. Fix:
1. Check if the element (or its builder function like `popover::menu_row`)
   already calls `.on_hover()`.
2. If so, use `.inspect_click()` instead of `.inspect_tag()`.
3. Or merge the inspector hover reporting into the existing `on_hover` closure
   using `report_hover()`.

### The inspector icon doesn't appear

- Ensure you're in a debug build, or set `COMET_INSPECTOR=1`.
- Check that `dev_inspector::init(cx)` is called in `Shell::new`.
- Check that `InspectorState::feature_enabled()` returns true.

### Hovering an element shows nothing

- The element must be tagged (see [How to tag elements](#how-to-tag-elements)).
- Elements using `.inspect_click()` only (no hover) won't show on hover, but
  will select on click.
- Elements using `popover::menu_row` / `btn_ghost` use `.inspect_click()` only
  by design (they already have internal `on_hover`).
