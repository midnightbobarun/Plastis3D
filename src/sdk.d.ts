// src/sdk.d.ts — minimal type declarations for @hermes/plugin-sdk (PR1 stub).
//
// @hermes/plugin-sdk has NO npm distribution: it is provided by the Desktop
// app at runtime, and esbuild externalizes it (see scripts/build-desktop.mjs).
// These declarations exist only so the TypeScript sources typecheck; they
// mirror the v0.23.0 Desktop SDK doc
// (~/.hermes/hermes-agent/website/docs/developer-guide/desktop-plugin-sdk.md)
// for the surfaces PR1 touches. They must be replaced by real SDK types if
// Hermes ever ships them — do not extend this stub into a shadow SDK.
//
// Only the surfaces used by src/ are declared here.
declare module "@hermes/plugin-sdk" {
 export const TRANSCRIPT_DIRECTIVE_AREA: "transcript.directives";
 export interface TranscriptDirectiveProps { attrs: Readonly<Record<string,string>>; source: string; streaming: boolean; sessionId?: string | null }

  /** Area constant for layout panes ('panes'). */
  export const PANES_AREA: string;
  /** Area constant for full pages ('routes'). */
  export const ROUTES_AREA: string;
  /** Area constant for sidebar nav rows ('sidebar.nav'). */
  export const SIDEBAR_NAV_AREA: string;
  /** Area constant for ⌘K palette commands ('palette'). */
  export const PALETTE_AREA: string;
  /** Area constants for the status bar clusters. */
  export const STATUSBAR_AREAS: { left: string; right: string };

  /** A readonly reactive atom: read with .get(), subscribe in React with useValue(). */
  export interface ReadableAtom<T> {
    get(): T;
    subscribe(listener: (value: T) => void): () => void;
  }

  /**
   * The host viewport state (SDK doc :1398):
   * `host.state.viewport` is `ReadableAtom<{ width, height, narrow }>`.
   * `narrow` is the host's layout signal — it is NOT derived from
   * window.matchMedia (the doc's ban on matchMedia as a narrow signal).
   */
  export interface ViewportState {
    width: number;
    height: number;
    narrow: boolean;
  }

  export interface PluginContribution {
    id: string;
    area: string;
    title?: string;
    order?: number;
    when?: () => boolean;
    enabled?: boolean;
    render?: () => unknown;
    data?: unknown;
  }

  export interface PluginStorage {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    remove(key: string): void;
  }
  export interface PluginSettingsPage { id: string; title: string; icon?: string; order?: number; render: () => import("react").ReactNode }
  export interface PluginContext {
    registerSettingsPage?: (page: PluginSettingsPage) => () => void;
    readonly source: string;
    register: (c: PluginContribution) => () => void;
    registerMany: (cs: PluginContribution[]) => () => void;
    onEvent: (type: string, listener: (event: unknown) => void) => () => void;
    onDispose: (fn: () => void) => void;
    setTimeout: (fn: () => void, ms: number) => () => void;
    setInterval: (fn: () => void, ms: number) => () => void;
    addEventListener: (
      target: EventTarget,
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions | boolean,
    ) => () => void;
    rest: <T>(path: string, opts?: unknown) => Promise<T>;
    /**
     * The folder-scoped file door (v0.23.0). Optional: feature-detect
     * with ctx.files?.… — an older shell reads as unavailable. Mirrors
     * the pinned host source (apps/desktop/src/contrib/plugin-files.ts):
     * folders() returns an array (not an envelope); requestFolder, list,
     * stat, and readDataUrl return { ok, error } envelopes; no member
     * throws. readDataUrl caps at a 16 MiB data URL; readText is 4 MiB
     * and returns `binary` for a GLB (not used by the import flow).
     */
    files?: PluginFiles;
    /** Plugin-scoped key/value storage (host contrib/plugin.ts
     *  createPluginStorage: JSON in the renderer's storage under
     *  hermes.plugin.<id>.<key>). Feature-detected (PR32 view prefs). */
    storage?: {
      get<T>(key: string, fallback: T): T;
      set(key: string, value: unknown): void;
      remove(key: string): void;
    };
  }

  /** One granted folder (opaque id; `path` is display-only). */
  export interface PluginFolder {
    /** Opaque handle to pass as `folder` to the other calls. */
    id: string;
    /** The folder's name, for display. */
    name: string;
    /** Absolute path the user picked, for display only — calls take `id`. */
    path: string;
  }

  /** One entry of a one-level folder listing. */
  export interface PluginFileEntry {
    name: string;
    /** Relative to the folder, `/`-separated; pass it back as `path`. */
    path: string;
    isDirectory: boolean;
  }

  /** A ctx.files result: success carries the payload, failure a code. */
  export type PluginFilesResult<T extends object = object> =
    | ({ ok: true } & T)
    | { ok: false; error: string; message: string };

  /**
   * The folder-scoped file door. A plugin reads and writes inside its
   * own data folder ('data') and inside folders the user granted it
   * through the app's picker, by RELATIVE path. Every call names a
   * folder handle and a path relative to that folder.
   */
  export interface PluginFiles {
    /** Handle of this plugin's private data folder (always available). */
    readonly dataFolder: "data";
    /** Ask the user for a folder with the app's own picker. `folder` is null on cancel. */
    requestFolder: () => Promise<PluginFilesResult<{ folder: PluginFolder | null }>>;
    /** Folders the user has granted this plugin and not revoked. */
    folders: () => Promise<PluginFolder[]>;
    /** Give a granted folder back. */
    release: (folderId: string) => Promise<boolean>;
    /** One-level listing: { ok, entries, truncated }. */
    list: (
      folder: string,
      path?: string,
    ) => Promise<PluginFilesResult<{ entries: PluginFileEntry[]; truncated: boolean }>>;
    /** { ok, exists, isDirectory?, size?, mtimeMs? }. */
    stat: (
      folder: string,
      path: string,
    ) => Promise<
      PluginFilesResult<{
        exists: boolean;
        isDirectory?: boolean;
        mtimeMs?: number;
        size?: number;
      }>
    >;
    /** UTF-8 text up to 4 MiB; a binary or larger file is refused, never truncated. */
    readText: (
      folder: string,
      path: string,
    ) => Promise<PluginFilesResult<{ mtimeMs: number; size: number; text: string }>>;
    /** A file (up to 16 MiB) as a `data:` URL, for image previews. */
    readDataUrl: (
      folder: string,
      path: string,
    ) => Promise<PluginFilesResult<{ url: string }>>;
    /** Write up to 4 MiB of UTF-8 text. The parent folder must exist. */
    writeText: (
      folder: string,
      path: string,
      text: string,
      options?: { exclusive?: boolean },
    ) => Promise<PluginFilesResult<{ mtimeMs: number; path: string; size: number }>>;
    /** Rename in place (same parent folder). */
    rename: (
      folder: string,
      path: string,
      name: string,
    ) => Promise<PluginFilesResult<{ path: string }>>;
    /** Move to the OS trash (recoverable). */
    trash: (folder: string, path: string) => Promise<PluginFilesResult>;
  }

  export interface HermesPlugin {
    id: string;
    name?: string;
    defaultEnabled?: boolean;
    capabilities?: readonly string[];
    register: (ctx: PluginContext) => void;
  }

  /** Host singleton: navigation, pane visibility, shared state. */
  export function ListRow(props: { title: import("react").ReactNode; description?: import("react").ReactNode; action?: import("react").ReactNode }): import("react").ReactElement;
  export function ToggleRow(props: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }): import("react").ReactElement;
  export function KbdGroup(props: { keys: string[]; className?: string }): import("react").ReactElement;
  export function writeClipboardText(text: string): Promise<void>;
  export const host: {
    composer: { insertText(sessionId: string | null, text: string, opts?: { mode: "block" }): Promise<boolean> };
    navigate: (path: string) => void;
    openSession?: (id: string, options?: { profile?: string; intent?: "in-place" | "stack" | "tab" | "window" }) => void | Promise<unknown>;
    paneVisibility: (paneId: string) => ReadableAtom<boolean>;
    /**
     * Every registered source in the current connection registry:
     * [{ profile, targetProfile, connectionId, mode }]. `profile` is
     * the source-local route; `targetProfile` is the backend Hermes
     * profile it serves; `connectionId` is the registry routing
     * identity — pair it with `profile` for keys and persistence.
     * (v0.23.0 SDK doc; PR3 decision 5: sourceKey = connectionId +
     * profile, desktop-side.)
     */
    profileRoutes: () => ProfileRoute[];
    /**
     * Shared host state atoms. The index signature covers the
     * open-ended set; `viewport` is declared explicitly (SDK doc
     * :1398) so `useValue(host.state.viewport).narrow` typechecks
     * without a cast at each read site (G-04 / G-15).
     */
    state: Record<string, ReadableAtom<unknown>> & {
      viewport: ReadableAtom<ViewportState>;
      focusedSessionId?: ReadableAtom<string | null>;
      focusedStoredSessionId?: ReadableAtom<string | null>;
      focusedSessionProfile?: ReadableAtom<string>;
    };
    /** In-app toast (ui-design-first-draft §"Toasts are host.notify"). */
    notify: (opts: {
      kind: "info" | "warning" | "error" | "success";
      message: string;
      title?: string;
      detail?: string;
    }) => string;
    notifyError: (error: unknown, fallbackMessage: string) => string;
  };

  /** One entry of host.profileRoutes(). */
  export interface ProfileRoute {
    profile: string;
    targetProfile: string;
    connectionId: string;
    mode: string;
  }

  /**
   * The gateway activation epoch: changes on every activation,
   * including a same-profile source swap. Capture it before an async
   * read or mutation and re-check it before publishing the result
   * (v0.23.0 SDK doc §"gatewayActivationEpoch").
   */
  export function gatewayActivationEpoch(): number;

  /**
   * Capture a gateway file download alongside a REST read, never at click
   * time. Returns a function that saves the gateway file at the captured
   * connection/profile. (PR1 spike probe only; the export pane in Stage 4
   * is the real consumer.)
   */
  export function captureGatewayFileDownload(): (
    path: string,
    suggestedName: string,
  ) => Promise<void>;

  export function useValue<T>(atom: ReadableAtom<T>): T;

  /**
   * The painted theme (SDK doc :407–418): `useTheme()` reads the
   * painted appearance (`theme`, `themeName`, `availableThemes`,
   * `resolvedMode`) and changes it (`setTheme`, `setMode`,
   * `previewTheme`) from a component. Only `themeName` is declared
   * here — it is the only field src/ reads (N-01: re-read the theme
   * when it changes). The hook exists in the installed SDK; there is
   * no "if absent, skip it" branch.
   */
  export function useTheme(): { themeName: string };

  // --- UI kit: the SIMPLE components only (Stage 5, PR5) -------------------
  // Prop shapes read from the pinned v0.23.0 checkout
  // (~/.hermes/hermes-agent/apps/desktop/src/components/ui/).
  // Compound Radix components (DropdownMenu, Select, Dialog, ContextMenu,
  // Tabs, ConfirmDialog) are NOT declared here: PR5 renders those as plain
  // HTML (button + div[role=menu] / div[role=dialog]), because their
  // portal/focus behaviour cannot be stubbed faithfully in the mock host
  // (audit exception, recorded in the PR5 report).

  export type ButtonVariant =
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "chip"
    | "ghost"
    | "grip"
    | "floating"
    | "link"
    | "text"
    | "textStrong";
  export type ButtonSize =
    | "default"
    | "xs"
    | "sm"
    | "lg"
    | "touch"
    | "inline"
    | "micro"
    | "icon"
    | "icon-xs"
    | "icon-sm"
    | "icon-lg"
    | "grip"
    | "icon-titlebar";
  export interface ButtonProps
    extends Omit<import("react").ComponentProps<"button">, "size"> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    asChild?: boolean;
    /** Working: the label stays in flow (invisible) with a spinner over it. */
    loading?: boolean;
  }
  export function Button(props: ButtonProps): import("react").ReactElement;

  export type InputSize = "xs" | "sm" | "default" | "lg";
  export interface InputProps
    extends Omit<import("react").ComponentProps<"input">, "size" | "prefix" | "suffix"> {
    /** Leading adornment rendered inside the field. */
    prefix?: import("react").ReactNode;
    /** Trailing adornment rendered inside the field. */
    suffix?: import("react").ReactNode;
    /** Applied to the wrapper when an adornment promotes the field to a group. */
    containerClassName?: string;
    size?: InputSize;
  }
  export function Input(props: InputProps): import("react").ReactElement;

  export type BadgeVariant =
    | "default"
    | "muted"
    | "success"
    | "warn"
    | "destructive"
    | "outline"
    | "solid";
  export type BadgeSize = "default" | "xs" | "overlay";
  export interface BadgeProps extends import("react").ComponentProps<"span"> {
    variant?: BadgeVariant;
    size?: BadgeSize;
    asChild?: boolean;
  }
  export function Badge(props: BadgeProps): import("react").ReactElement;

  export interface CodiconProps extends import("react").HTMLAttributes<HTMLElement> {
    name: string;
    size?: number | string;
    spinning?: boolean;
  }
  export function Codicon(props: CodiconProps): import("react").ReactElement;

  export interface EmptyStateProps {
    title: string;
    description?: string;
    className?: string;
  }
  export function EmptyState(props: EmptyStateProps): import("react").ReactElement;

  export interface ErrorStateProps {
    children?: import("react").ReactNode;
    className?: string;
    description?: import("react").ReactNode;
    icon?: import("react").ReactNode;
    title: import("react").ReactNode;
  }
  export function ErrorState(props: ErrorStateProps): import("react").ReactElement;

  export type CopyButtonAppearance =
    | "button"
    | "icon"
    | "inline"
    | "menu-item"
    | "context-menu-item"
    | "tool-row";
  export interface CopyButtonProps {
    appearance?: CopyButtonAppearance;
    buttonSize?: ButtonProps["size"];
    buttonVariant?: ButtonProps["variant"];
    children?: import("react").ReactNode;
    className?: string;
    disabled?: boolean;
    errorMessage?: string;
    haptic?: boolean;
    iconClassName?: string;
    label?: string;
    onCopied?: () => void;
    onCopyError?: (error: unknown) => void;
    preventDefault?: boolean;
    showLabel?: boolean;
    side?: TipProps["side"];
    stopPropagation?: boolean;
    text: string | (() => Promise<string> | string);
    title?: string;
  }
  export function CopyButton(props: CopyButtonProps): import("react").ReactElement;

  export interface GlyphSpinnerProps {
    ariaLabel?: string;
    className?: string;
    paused?: boolean;
    spinner?: string;
  }
  export function GlyphSpinner(props: GlyphSpinnerProps): import("react").ReactElement;

  /**
   * Pulsing placeholder block (SDK doc UI-kit list :2104/:2493;
   * `apps/desktop/src/components/ui/skeleton.tsx` exports `Skeleton`
   * as a div with `data-slot="skeleton"`). Props are the div's own.
   * Declared the PR5 way (G-12): the loading branches render it in
   * the canvas area while the first scene GET is in flight.
   */
  export type SkeletonProps = import("react").ComponentProps<"div">;
  export function Skeleton(props: SkeletonProps): import("react").ReactElement;

  /**
   * Thin rule between groups (SDK doc UI-kit list :2104/:2493;
   * `apps/desktop/src/components/ui/separator.tsx` exports
   * `Separator` as a Radix `SeparatorPrimitive.Root` with
   * `data-slot="separator"`). Radix-based but portal-free, unlike
   * Dialog — the mock host can stub it as a plain element (N-03).
   * Declared the PR5 way.
   */
  export interface SeparatorProps
    extends Omit<import("react").ComponentProps<"div">, "children"> {
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  }
  export function Separator(props: SeparatorProps): import("react").ReactElement;

  /**
   * Coloured status dot (SDK doc UI-kit list :2104/:2493;
   * `apps/desktop/src/components/status-dot.tsx`: a span with
   * `aria-hidden`, `tone` one of good/muted/warn/bad). Declared the
   * PR5 way (G-14: the "Scene store not answering" indicator on the
   * pane stats line uses tone "warn").
   */
  export type StatusTone = "good" | "muted" | "warn" | "bad";
  export interface StatusDotProps
    extends import("react").ComponentProps<"span"> {
    tone: StatusTone;
  }
  export function StatusDot(props: StatusDotProps): import("react").ReactElement;

  export interface SearchFieldProps {
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
    hints?: string[];
    containerClassName?: string;
    inputClassName?: string;
    loading?: boolean;
    onClear?: () => void;
    onKeyDown?: import("react").KeyboardEventHandler<HTMLInputElement>;
    inputRef?: import("react").RefObject<HTMLInputElement | null>;
    trailingAction?: import("react").ReactNode;
    leadingContent?: import("react").ReactNode;
    variant?: "underline" | "box";
    "aria-label"?: string;
  }
  export function SearchField(props: SearchFieldProps): import("react").ReactElement;

  export interface TipProps {
    label: import("react").ReactNode;
    children: import("react").ReactNode;
    delayDuration?: number;
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    sideOffset?: number;
    alignOffset?: number;
  }
  export function Tip(props: TipProps): import("react").ReactElement;

  export interface CheckboxProps {
    checked?: boolean | "indeterminate";
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean | "indeterminate") => void;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    value?: string;
    className?: string;
    id?: string;
    "aria-label"?: string;
  }
  export function Checkbox(props: CheckboxProps): import("react").ReactElement;

  export interface SegmentedControlOption<T extends string> {
    id: T;
    label: string;
  }
  export interface SegmentedControlProps<T extends string> {
    options: readonly SegmentedControlOption<T>[];
    value: T;
    onChange: (id: T) => void;
    className?: string;
    disabled?: boolean;
    sizing?: "equal" | "content";
  }
  export function SegmentedControl<T extends string>(
    props: SegmentedControlProps<T>,
  ): import("react").ReactElement;
}
