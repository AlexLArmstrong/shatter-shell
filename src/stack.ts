import type { Rect } from './core/geom.js';
import type { Ext } from './extension.js';
import type { MutterWindowHandle } from './gnome/mutter_window_handle.js';
import type { NodeStack } from './node.js';
import type * as Settings from './settings.js';

import * as a from './arena.js';
import * as Node from './node.js';

const Arena = a.Arena;
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

enum TabActive {
    active,
    inactive,
    urgent,
}

export const TAB_HEIGHT_UNSCALED = 43 as const;

/** Space between the tab bar and the window. This is already included in {@link TAB_HEIGHT_UNSCALED}. */
const TAB_SEPARATION_UNSCALED = 3 as const;

interface Tab {
    id: WindowId;
    button: number;
    button_signal: SignalID | null;
    signals: Array<SignalID>;
}

interface StackWidgets {
    tabs: St.Widget;
}

function stack_widgets_new(): StackWidgets {
    const tabs = new St.BoxLayout({
        style_class: 'shatter-shell-stack',
        x_expand: true,
        accessible_role: Atk.Role.PAGE_TAB_LIST,
    });

    tabs.get_layout_manager()?.set_homogeneous(true);

    return { tabs };
}

const TabButton = GObject.registerClass(
    {
        Signals: { activate: {} },
    },
    class TabButton extends St.Button {
        declare _title: St.Label;
        declare _settings: Settings.ExtensionSettings;

        override _init(window: MutterWindowHandle, settings: Settings.ExtensionSettings) {
            this._settings = settings;

            const icon = window.icon(Math.floor(TAB_HEIGHT_UNSCALED * 0.4));
            icon.set_x_align(Clutter.ActorAlign.START);
            icon.set_style('padding: 4px; margin-left: 4px;');

            const title = (this._title = new St.Label({
                y_expand: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding-left: 4px; padding-right: 4px;',
                text: window.title(),
            }));

            const close_button = new St.Button({
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: Math.floor(TAB_HEIGHT_UNSCALED * 0.4),
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                y_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'shatter-shell-window-close',
            });
            const on_close = close_button.connect('clicked', () => {
                window.meta.delete(global.get_current_time());
                close_button.disconnect(on_close);
            });

            const container = new St.BoxLayout({
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'shatter-shell-tab-inner',
            });
            container.add_child(icon);
            container.add_child(title);
            container.add_child(close_button);

            super._init({
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                toggle_mode: true,
                child: container,
                accessible_role: Atk.Role.PAGE_TAB,
            });
        }

        set_title(text: string) {
            this._title.text = text;
        }

        set_active(tabActive: TabActive) {
            const hint_color_rgba = this._settings.get_hint_color_rgba();
            this.style = `--accent-color: ${hint_color_rgba};`;

            switch (tabActive) {
                case TabActive.active:
                    this.style_class = 'shatter-shell-tab';
                    this.checked = true;
                    break;
                case TabActive.inactive:
                    // Don't dismiss urgent state
                    const wasUrgent = this.has_style_class_name('shatter-shell-tab-urgent');
                    if (!wasUrgent) {
                        this.style_class = 'shatter-shell-tab';
                        this.checked = false;
                    }
                    break;
                case TabActive.urgent:
                    this.style_class = 'shatter-shell-tab shatter-shell-tab-urgent';
                    this.checked = true;
                    break;
            }
        }
    },
);

export class Stack {
    ext: Ext;

    /**
     * The leaf of the tree that this draws, which holds everything there is to know about the stack:
     * its windows, their order, and which of them is active. A leaf and its Stack are created and
     * destroyed together, and only the functions in node.ts change the leaf.
     */
    readonly node: NodeStack;

    widgets: StackWidgets | null = null;

    /**
     * One tab per window of the leaf, in its order, as last drawn. This only holds each tab's widgets
     * and signals, and sync rebuilds it from the leaf whenever the leaf changes.
     */
    tabs: Array<Tab> = [];

    /** The active window as last drawn, so that sync can tell whether it changed */
    private drawn_active: WindowId | null = null;

    /** The window whose position and size the tab bar follows, with its signals */
    private followed: [Meta.Window, SignalID, SignalID] | null = null;

    buttons: a.Arena<typeof TabButton.prototype> = new Arena();

    tab_height: number;
    tab_separation: number;

    stack_rect: Mtk.Rectangle = new Mtk.Rectangle({ x: 0, y: 0, width: 0, height: 0 });

    private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };

    private restacker: SignalID = global.display.connect('restacked', () => this.restack());

    private focus_watcher: SignalID = global.display.connect('notify::focus-window', () => this.update_focus());

    private tabs_destroy: SignalID;

    constructor(ext: Ext, node: NodeStack) {
        this.ext = ext;
        this.node = node;
        this.tab_height = TAB_HEIGHT_UNSCALED * this.ext.sizes.scale;
        this.tab_separation = TAB_SEPARATION_UNSCALED * this.ext.sizes.scale;

        this.widgets = stack_widgets_new();

        global.window_group.add_child(this.widgets.tabs);

        this.reposition();

        this.tabs_destroy = this.widgets.tabs.connect('destroy', () => this.recreate_widgets());

        this.follow_active();
    }

    /** The window that is shown, which the leaf decides */
    get active(): WindowId {
        return this.node.active;
    }

    /** The window that was shown before, which the leaf decides */
    get prev_active(): WindowId | null {
        return this.node.prev_active;
    }

    /** The index of the active tab, or -1 if it has none */
    get active_id(): number {
        return this.index_of(this.active);
    }

    private index_of(window_id: WindowId): number {
        return this.tabs.findIndex(tab => tab.id === window_id);
    }

    /**
     * Draws the leaf: makes the tabs match its windows, in their order, shows its active window and
     * hides the others, and releases the windows that left. It's called whenever the leaf changes.
     */
    sync() {
        if (!this.widgets) return;

        const windows: Array<MutterWindowHandle> = [];
        for (const window_id of this.node.windows) {
            const window = this.ext.windows.get(window_id);
            if (window) windows.push(window);
        }

        const in_windows = (window_id: WindowId) => windows.some(window => window.id === window_id);
        const added: Array<WindowId> = [];

        for (let idx = this.tabs.length - 1; idx >= 0; idx -= 1) {
            const tab = this.tabs[idx];
            if (tab && !in_windows(tab.id)) {
                this.remove_tab_component(tab, idx);
            }
        }

        for (const window of windows) {
            if (this.index_of(window.id) === -1) {
                this.add_tab(window);
                added.push(window.id);
            }
        }

        const ordered: Array<Tab> = [];
        for (const window of windows) {
            const tab = this.tabs[this.index_of(window.id)];
            if (tab) ordered.push(tab);
        }
        this.tabs = ordered;

        for (const [idx, tab] of this.tabs.entries()) {
            const button = this.buttons.get(tab.button);
            if (button) this.widgets.tabs.set_child_at_index(button, idx);
        }

        if (this.drawn_active === null || this.drawn_active !== this.active) {
            this.follow_active();
        }

        this.show_active(added);
    }

    /** Adds a tab for the window, without changing whether the window is shown */
    private add_tab(window: MutterWindowHandle) {
        if (!this.widgets) return;

        const window_id = window.id;
        const active = window_id === this.active;

        const button = new TabButton(window, this.ext.settings);
        button.natural_height = this.tab_height - this.tab_separation;
        button.set_active(active ? TabActive.active : TabActive.inactive);
        const id = this.buttons.insert(button);

        const tab: Tab = { id: window_id, signals: [], button: id, button_signal: null };
        this.bind_hint_events(tab);
        this.tabs.push(tab);
        this.update_focus();
        this.watch_signals(tab, window);
        this.widgets.tabs.add_child(button);
    }

    activate_prev() {
        if (this.prev_active !== null) this.activate(this.prev_active);
    }

    /** Shows this window of the stack, by changing the leaf */
    activate(window_id: WindowId) {
        Node.stack_activate(this.ext.tab_bars, this.node, window_id);
    }

    /**
     * Shows the active tab's window and hides the others, and marks the active tab. Windows on
     * another workspace are shown by mutter along with it, so the tab bar only shows where the
     * stack may. The windows of tabs that were only just added change without fading.
     */
    private show_active(added: Array<WindowId>) {
        if (!this.widgets) return;
        this.widgets.tabs.visible = this.permitted_to_show();
        this.drawn_active = this.active;

        for (const tab of this.tabs) {
            this.window_exec(tab, tab.id, window => {
                const active = tab.id === this.active;
                const is_new = added.some(window_id => window_id === tab.id);

                if (active) {
                    if (is_new) window.visibility.show_now();
                    else window.visibility.fade_in();
                } else if (is_new) {
                    window.visibility.hide_now();
                } else {
                    window.visibility.fade_out();
                }

                this.buttons.get(tab.button)?.set_active(active ? TabActive.active : TabActive.inactive);
            });
        }
    }

    /** Makes the tab bar follow the position and size of the active window */
    private follow_active() {
        this.unfollow();

        const window = this.ext.windows.get(this.active);
        if (!window) return;

        const on_window_changed = () =>
            this.on_grab(() => {
                const window = this.ext.windows.get(this.active);
                if (window) {
                    this.update_positions(window.meta.get_frame_rect());
                    this.window_changed();
                } else {
                    this.unfollow();
                }
            });

        this.followed = [
            window.meta,
            window.meta.connect('size-changed', on_window_changed),
            window.meta.connect('position-changed', on_window_changed),
        ];
    }

    /** Disconnects from the window that the tab bar follows */
    private unfollow() {
        if (this.followed) {
            const [meta, ...signals] = this.followed;
            for (const signal of signals) meta.disconnect(signal);
        }

        this.followed = null;
    }

    private active_meta(): Meta.Window | undefined {
        return this.ext.windows.get(this.active)?.meta;
    }

    private bind_hint_events(tab: Tab) {
        const settings = this.ext.settings;
        const button = this.buttons.get(tab.button);
        if (button) {
            const change_id = settings.ext.connect('changed', (_, key) => {
                if (key === 'hint-color-rgba') {
                    const active = tab.id === this.active;
                    button.set_active(active ? TabActive.active : TabActive.inactive);
                }
                return false;
            });
            button.connect('destroy', () => {
                settings.ext.disconnect(change_id);
            });
            const active = tab.id === this.active;
            button.set_active(active ? TabActive.active : TabActive.inactive);
        }
    }

    /** Disconnects a tab from the stack, and fades its window back in if the stack is on the active workspace */
    tab_disconnect(c: Tab) {
        this.unwatch(c);
        const active = global.workspace_manager.get_active_workspace();
        if (this.active_meta()?.get_workspace() === active) this.ext.windows.get(c.id)?.visibility.fade_in();
    }

    /** Disconnects the signals of a tab, without changing whether its window is shown */
    private unwatch(c: Tab) {
        const window = this.ext.windows.get(c.id);
        if (window) {
            for (const s of c.signals) window.meta.disconnect(s);
        }

        c.signals = [];

        if (c.button_signal != null) {
            const b = this.buttons.get(c.button);
            if (b) {
                b.disconnect(c.button_signal);
                c.button_signal = null;
            }
        }
    }

    /** Disconnects this stack's signal, and destroys its widgets */
    destroy() {
        global.display.disconnect(this.restacker);
        global.display.disconnect(this.focus_watcher);
        this.unfollow();

        // Disconnect stack signals from each window, which also unhides them
        for (const c of this.tabs) this.tab_disconnect(c);

        for (const b of this.buttons.values()) {
            b.destroy();
        }
        this.buttons.truncate(0);

        if (this.widgets) {
            const tabs = this.widgets.tabs;
            this.widgets = null;
            tabs.destroy();
        }
    }

    private on_grab(or: () => void) {
        if (this.ext.grab.window !== null) {
            if (this.ext.grab.window === this.ext.windows.get(this.active)) {
                if (this.widgets) {
                    const parent = this.widgets.tabs.get_parent();
                    const actor = this.active_meta()?.get_compositor_private<Meta.WindowActor | null>();
                    if (actor && parent) {
                        parent.set_child_below_sibling(this.widgets.tabs, actor);
                    }
                }

                return;
            }
        }

        or();
    }

    /** Workaround for when GNOME Shell destroys our widgets when they're reparented
     *  in an active workspace change. */
    recreate_widgets() {
        if (this.widgets !== null) {
            this.widgets.tabs.disconnect(this.tabs_destroy);
            this.widgets = stack_widgets_new();

            global.window_group.add_child(this.widgets.tabs);

            this.tabs_destroy = this.widgets.tabs.connect('destroy', () => this.recreate_widgets());

            // Only the buttons are rebuilt, and the windows stay as they are
            const tabs = this.tabs.splice(0);
            for (const c of tabs) this.unwatch(c);
            this.buttons.truncate(0);
            for (const c of tabs) {
                const window = this.ext.windows.get(c.id);
                if (window) this.add_tab(window);
            }

            this.update_positions(this.rect);
            this.restack();
        }
    }

    private remove_tab_component(c: Tab, idx: number) {
        if (!this.widgets) return;

        this.tab_disconnect(c);

        const b = this.buttons.get(c.button);
        if (b) {
            this.widgets.tabs.remove_child(b);
            b.destroy();
            this.buttons.remove(c.button);
        }

        this.tabs.splice(idx, 1);
        this.update_focus();
    }

    /** Repositions the stack, arranging the stack's actors around the active window */
    reposition() {
        if (!this.widgets) return;

        const window = this.ext.windows.get(this.active);
        if (!window) return;

        const actor = window.meta.get_compositor_private<Meta.WindowActor | null>();
        if (!actor) {
            this.unfollow();
            return;
        }

        const parent = actor.get_parent();

        if (!parent) {
            return;
        }

        const stack_parent = this.widgets.tabs.get_parent();
        if (stack_parent) {
            stack_parent.remove_child(this.widgets.tabs);
        }

        parent.add_child(this.widgets.tabs);

        // Reposition actors on the screen, being careful about not displaying over maximized windows
        if (!window.meta.is_fullscreen() && !window.is_maximized() && !this.ext.maximized_on_active_display()) {
            parent.set_child_above_sibling(this.widgets.tabs, actor);
        } else {
            parent.set_child_below_sibling(this.widgets.tabs, actor);
        }
    }

    /** Whether the stack is permitted to show on the active workspace. */
    permitted_to_show(): boolean {
        const active = global.workspace_manager.get_active_workspace();
        const window = this.active_meta();
        return window?.located_on_workspace(active) ?? false;
    }

    /**
     * Places the tab bar, and shows it only where the stack may show. It also shows the active tab's
     * window and hides the others again, as mutter shows every window of a workspace on entering it.
     */
    restack() {
        this.on_grab(() => {
            if (!this.widgets) return;

            const permitted = this.permitted_to_show();

            this.widgets.tabs.visible = permitted;

            if (permitted) this.reposition();

            this.show_active([]);
        });
    }

    /** Draws the tabs at half opacity unless the stack has the focused window, as libadwaita does with unfocused header bars. */
    private update_focus() {
        const focus_window = global.display.focus_window;
        const focused = this.tabs.some(tab => this.ext.windows.get(tab.id)?.meta === focus_window);

        for (const tab of this.tabs) {
            const button = this.buttons.get(tab.button);
            if (button) button.opacity = focused ? 255 : 128;
        }
    }

    /** Changes visibility of the stack's actors */
    set_visible(visible: boolean) {
        if (!this.widgets) return;

        this.widgets.tabs.visible = visible;

        if (visible) {
            this.widgets.tabs.show();
        } else {
            this.widgets.tabs.hide();
        }
    }

    /** Updates the dimensions and positions of the stack's actors */
    update_positions(rect: Rect) {
        if (!this.widgets) return;

        this.rect = rect;

        this.tab_height = TAB_HEIGHT_UNSCALED * this.ext.sizes.scale;
        this.tab_separation = TAB_SEPARATION_UNSCALED * this.ext.sizes.scale;

        this.stack_rect = new Mtk.Rectangle({
            x: rect.x,
            y: rect.y - this.tab_height,
            width: rect.width,
            height: rect.height + this.tab_height,
        });

        this.widgets.tabs.x = rect.x;
        this.widgets.tabs.y = this.stack_rect.y;
        this.widgets.tabs.height = this.tab_height - this.tab_separation;
        this.widgets.tabs.width = rect.width;
    }

    private watch_signals(tab: Tab, window: MutterWindowHandle) {
        const window_id = window.id;
        const widget = this.buttons.get(tab.button);
        if (!widget) return;

        // Detach button signal if it's still attached
        if (tab.button_signal != null) widget.disconnect(tab.button_signal);

        // Connect tab-clicked signal
        tab.button_signal = widget.connect('clicked', () => {
            this.activate(window_id);
            this.window_exec(tab, window_id, window => {
                this.ext.register_fn(() => window.request_activate(false));
                this.reposition();
            });
        });

        // Detach signals if they're still attached
        for (const signal of tab.signals) window.meta.disconnect(signal);

        // Attach new signals
        tab.signals = [
            window.meta.connect('notify::title', () => {
                this.window_exec(tab, window_id, window => {
                    this.buttons.get(tab.button)?.set_title(window.title());
                });
            }),

            window.meta.connect('notify::urgent', () => {
                this.window_exec(tab, window_id, window => {
                    if (!window.meta.has_focus()) {
                        this.buttons.get(tab.button)?.set_active(TabActive.urgent);
                    }
                });
            }),
        ];
    }

    private window_changed() {
        this.ext.show_border_on_focused();
    }

    private window_exec(tab: Tab, window_id: WindowId, func: (window: MutterWindowHandle) => void) {
        const window = this.ext.windows.get(window_id);
        if (window && window.actor_exists()) {
            func(window);
        } else {
            this.tab_disconnect(tab);
        }
    }
}
