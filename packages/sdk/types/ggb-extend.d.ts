// Type declarations for @neogebra/sdk.
declare module '@neogebra/sdk' {
  /** SDK version string. */
  export const VERSION: string;

  /* ----------------------------- Events ----------------------------- */

  export type Unsubscribe = () => void;

  export class Emitter {
    on(type: string, handler: (payload: any) => void): Unsubscribe;
    once(type: string, handler: (payload: any) => void): Unsubscribe;
    off(type: string, handler?: (payload: any) => void): void;
    emit(type: string, payload?: any): void;
    clear(): void;
  }

  export type GgbEvent =
    | 'add'
    | 'remove'
    | 'update'
    | 'rename'
    | 'clear'
    | 'click';

  export interface GgbEventPayloads {
    add: { name: string };
    remove: { name: string };
    update: { name: string };
    rename: { oldName: string; newName: string };
    clear: {};
    click: { name: string };
  }

  /* --------------------------- Geometry API -------------------------- */

  export interface Coords {
    x: number;
    y: number;
    z: number;
  }

  /** Promise-based object manipulation API. */
  export interface ObjectsApi {
    /** Run a raw GeoGebra command string (e.g. "A=(1,2)"). */
    eval(command: string): Promise<boolean>;
    /** Create a free point; resolves to the object's name. */
    createPoint(x: number, y: number, name?: string): Promise<string>;
    /** Create a segment between two points/coords; resolves to the object's name. */
    createSegment(a: string, b: string, name?: string): Promise<string>;
    /** Read a numeric value for an object or expression. */
    getValue(name: string): Promise<number>;
    /** Read an object's coordinates. */
    getCoords(name: string): Promise<Coords>;
    /** Move an object; resolves to its new coordinates. */
    setCoords(name: string, x: number, y: number, z?: number): Promise<Coords>;
    /** Show or hide an object. */
    setVisible(name: string, visible: boolean): Promise<void>;
    /** Set an object's RGB color (0–255). */
    setColor(name: string, r: number, g: number, b: number): Promise<void>;
    /** Delete an object. */
    remove(name: string): Promise<void>;
    /** List all object names in the construction. */
    list(): Promise<string[]>;
    /** Whether an object exists. */
    exists(name: string): Promise<boolean>;
  }

  export interface WhenReadyOptions {
    timeout?: number;
    getApplet?: () => GgbApplet | null;
  }

  /** Resolve once the GeoGebra applet API is ready. */
  export function whenAppletReady(opts?: WhenReadyOptions): Promise<GgbApplet>;

  /** Modern facade over the GeoGebra applet. */
  export class GgbCore {
    constructor(applet: GgbApplet);
    /** Async factory that waits for the applet to be ready. */
    static create(opts?: WhenReadyOptions): Promise<GgbCore>;

    /** The raw, un-wrapped GeoGebra applet (escape hatch). */
    readonly raw: GgbApplet;
    /** SDK event emitter bridging GeoGebra's listeners. */
    readonly events: Emitter;
    /** Promise-based geometry API. */
    readonly objects: ObjectsApi;

    on<T extends GgbEvent>(type: T, handler: (payload: GgbEventPayloads[T]) => void): Unsubscribe;
    once<T extends GgbEvent>(type: T, handler: (payload: GgbEventPayloads[T]) => void): Unsubscribe;
    dispose(): void;
  }

  /* ----------------------------- Plugins ---------------------------- */

  export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    main: string;
    author?: string;
    description?: string;
    icon?: string | null;
    engines?: { ngbLoader?: string };
    /** Declared capabilities. `network` lists hostnames the plugin may reach via
     *  ctx.net.fetch (the user must still approve each on first use). */
    permissions?: { network?: string[] };
  }

  /** A guarded network response (from ctx.net.fetch). */
  export interface NetResponse<T = any> {
    ok: boolean;
    status: number;
    statusText?: string;
    headers?: Record<string, string | string[]>;
    /** Parsed JSON body when the response was JSON, else null. */
    data?: T | null;
    /** Raw response text. */
    text?: string;
    /** Present on failures. */
    error?: string;
    code?: string;
  }

  export interface NetFetchOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    /** String, or any JSON-serializable value (sent as JSON). */
    body?: any;
    timeoutMs?: number;
  }

  /** Scoped network access. Only hosts declared in the manifest's
   *  permissions.network AND approved by the user can be reached. */
  export interface PluginNet {
    fetch<T = any>(url: string, opts?: NetFetchOptions): Promise<NetResponse<T>>;
  }

  /** Scoped key/value storage handed to each plugin. */
  export interface PluginStorage {
    get<T = any>(key: string, fallback?: T): T;
    set<T = any>(key: string, value: T): T;
    delete(key: string): void;
    keys(): string[];
  }

  export interface HostBridge {
    version: string;
    getPlugins(): Promise<{ ok: boolean; plugins: PluginManifest[]; root: string }>;
    togglePlugin(id: string, enabled: boolean): Promise<{ ok: boolean }>;
    openPluginFolder(): Promise<{ ok: boolean; path?: string }>;
    getSettings(): Promise<{ ok: boolean; settings: Record<string, any> }>;
    setSettings(s: Record<string, any>): Promise<{ ok: boolean; settings: Record<string, any> }>;
  }

  export class MemoryStorage implements PluginStorage {
    get<T = any>(key: string, fallback?: T): T;
    set<T = any>(key: string, value: T): T;
    delete(key: string): void;
    keys(): string[];
  }

  export interface PluginLogger {
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  }

  /** Everything a plugin gets without touching globals. */
  export interface DockMountOptions {
    id?: string;
    collapsible?: boolean;
    collapsed?: boolean;
    title?: string;
    onDockChange?: (docked: boolean) => void;
  }

  /** Handle to a panel mounted into GeoGebra's UI. Render into `element`. */
  export interface DockController {
    /** The element to render your UI into. */
    element: HTMLElement;
    host: HTMLElement;
    shadow: ShadowRoot;
    /** True when actually docked inside the algebra view (vs floating fallback). */
    isDocked(): boolean;
    collapsed(): boolean;
    setCollapsed(v: boolean): void;
    reattach(): void;
    destroy(): void;
  }

  export interface PluginUi {
    /** Mount a panel into GeoGebra's algebra view (left column, below the tree),
     *  falling back to a floating panel if the algebra view isn't available. */
    mountInAlgebraView(opts?: DockMountOptions): DockController;
  }

  /** Mount a panel into GeoGebra's algebra view. Prefer ctx.ui.mountInAlgebraView. */
  export function mountInAlgebraView(opts?: DockMountOptions): DockController;

  export class PluginContext {
    constructor(opts: {
      core: GgbCore;
      manifest: PluginManifest;
      storage?: PluginStorage;
      host?: HostBridge | null;
      net?: PluginNet | null;
      ui?: PluginUi | null;
    });
    readonly core: GgbCore;
    readonly manifest: PluginManifest;
    readonly id: string;
    readonly storage: PluginStorage;
    readonly host: HostBridge | null;
    /** Guarded network access (manifest-declared + user-approved hosts). */
    readonly net: PluginNet | null;
    /** UI mounting helpers (mount a panel into GeoGebra's UI). */
    readonly ui: PluginUi | null;
    readonly log: PluginLogger;
    /** Register cleanup run automatically on disable/unload. */
    registerDisposable(fn: () => void): () => void;
    runDisposables(): void;
  }

  /** Base class for plugins. Override the hooks you need; all are optional/async. */
  export class Plugin {
    constructor(ctx: PluginContext);
    readonly ctx: PluginContext;
    onLoad(ctx: PluginContext): void | Promise<void>;
    onEnable(ctx: PluginContext): void | Promise<void>;
    onDisable(ctx: PluginContext): void | Promise<void>;
    onUnload(ctx: PluginContext): void | Promise<void>;
    /** Open this plugin's settings UI (called by the panel's "设置" button). */
    onOpenSettings(ctx: PluginContext): void | Promise<void>;
  }

  /** A plugin may also be a plain object implementing these hooks. */
  export interface PluginHooks {
    onLoad?(ctx: PluginContext): void | Promise<void>;
    onEnable?(ctx: PluginContext): void | Promise<void>;
    onDisable?(ctx: PluginContext): void | Promise<void>;
    onUnload?(ctx: PluginContext): void | Promise<void>;
    onOpenSettings?(ctx: PluginContext): void | Promise<void>;
  }

  export function validateManifest(manifest: unknown): PluginManifest;

  export function runLifecycle(
    instance: Plugin | PluginHooks,
    phase: 'onLoad' | 'onEnable' | 'onDisable' | 'onUnload',
    ctx: PluginContext
  ): Promise<void>;
}

/**
 * Curated subset of the native GeoGebra applet API. The real applet exposes
 * many more methods — see https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_API/
 * Use `GgbCore.raw` to reach anything not declared here.
 */
interface GgbApplet {
  evalCommand(cmdString: string): boolean;
  evalCommandGetLabels(cmdString: string): string;
  getValue(objName: string): number;
  setValue(objName: string, value: number): void;
  getXcoord(objName: string): number;
  getYcoord(objName: string): number;
  getZcoord?(objName: string): number;
  setCoords?(objName: string, x: number, y: number, z?: number): void;
  setVisible(objName: string, visible: boolean): void;
  setColor(objName: string, red: number, green: number, blue: number): void;
  deleteObject(objName: string): void;
  exists?(objName: string): boolean;
  getObjectNumber(): number;
  getObjectName(index: number): string;
  getObjectType(objName: string): string;
  getAllObjectNames(type?: string): string[];
  registerAddListener(fn: (objName: string) => void): void;
  registerRemoveListener(fn: (objName: string) => void): void;
  registerUpdateListener(fn: (objName: string) => void): void;
  registerRenameListener(fn: (oldName: string, newName: string) => void): void;
  registerClearListener(fn: () => void): void;
  registerClickListener?(fn: (objName: string) => void): void;
  [key: string]: any;
}

interface Window {
  ggbApplet?: GgbApplet;
  ggbExtendHost?: import('@neogebra/sdk').HostBridge;
  __ggbExtendToggle__?: () => void;
  __ggbExtendReady__?: boolean;
}
