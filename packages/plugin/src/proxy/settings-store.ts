import { saveSettings, type Settings } from "../config/settings.js";
import { appendLog } from "./route-log.js";

/**
 * The proxy's single owner of mutable settings.
 *
 * Requests used to take a snapshot, route for seconds or minutes (streaming),
 * then assign their snapshot back — silently reverting any Admin edit made
 * meanwhile, and the router saved that stale snapshot to disk mid-request.
 * Now every change is a function applied to the *current* value, and
 * routing reports only the model-access entries it learned.
 */
export class SettingsStore {
  private current: Settings;
  private warned = false;

  constructor(
    initial: Settings,
    /** Undefined = in-memory only (tests). */
    private readonly home?: string
  ) {
    this.current = initial;
  }

  get(): Settings {
    return this.current;
  }

  update(change: (settings: Settings) => Settings): Settings {
    this.current = change(this.current);
    this.persist();
    return this.current;
  }

  /** Merge access entries learned by a request into the live settings. */
  learnAccess(delta: Settings["modelAccess"]): void {
    if (Object.keys(delta).length === 0) return;
    this.update((s) => ({ ...s, modelAccess: { ...s.modelAccess, ...delta } }));
  }

  private persist(): void {
    if (this.home === undefined) return;
    try {
      saveSettings(this.current, this.home);
    } catch (error) {
      if (this.warned) return;
      this.warned = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`free-opencode: could not save settings: ${message}\n`);
      void appendLog("settings.persist_failed", { message }, this.home);
    }
  }
}
