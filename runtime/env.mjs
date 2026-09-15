/**
 * Netlify.env compatibility shim.
 *
 * The commercial API handlers read configuration through `Netlify.env.get(...)`,
 * which is a Netlify runtime global. On any other Node host (Northflank, Render,
 * Fly, a plain VM, Docker, ...) we install an equivalent global backed by
 * `process.env` before the handlers are imported.
 *
 * This module intentionally has no dependencies and never overwrites a real
 * Netlify runtime if one is already present.
 */

export function installEnvShim(env = process.env) {
  const existing = globalThis.Netlify;
  if (existing && typeof existing.env?.get === "function") {
    return false; // Running on Netlify (or a host that already provides it).
  }

  globalThis.Netlify = {
    env: {
      get(name) {
        const value = env[name];
        // Netlify.env.get() resolves to undefined for unset variables.
        return value === undefined ? undefined : value;
      },
      has(name) {
        return env[name] !== undefined;
      },
      toObject() {
        return { ...env };
      }
    }
  };

  return true;
}
