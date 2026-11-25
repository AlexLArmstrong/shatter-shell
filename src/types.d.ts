/** The ID of a monitor in the display server. */
type MonitorID = number & { readonly __type: unique symbol };

/** The ID of a workspace in GNOME Shell */
type WorkspaceID = (number & { readonly __type: unique symbol }) | 0;

type MonitorWorkspaceID = [monitor: MonitorID, workspace: WorkspaceID];

type SignalID = number;

/** The ID of a window: mutter's stable sequence for it, which it never reuses */
type WindowId = number;
