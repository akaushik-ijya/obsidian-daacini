"use strict";
/*
 * IjyaLabs DaaCini for Obsidian — renders ```daacini fenced blocks (plus
 * legacy ```mermaid-pp, for notes written before the rename) as diagrams.
 *
 * The plugin is a thin shim: it hands the fence's text to a DaaCini service
 * (`POST /render`, text in → SVG out) and injects the SVG into the note. The
 * engine is deterministic, so results are cached per (theme + source). Requests
 * go through Obsidian's `requestUrl` (not fetch) so there is never a CORS issue.
 *
 * Point it at a local `daacini serve` (default http://127.0.0.1:4180) or a
 * hosted instance in the plugin settings. No document text leaves the machine
 * when the endpoint is loopback. (We default to 127.0.0.1 rather than
 * `localhost`: on a dual-stack host `localhost` can resolve to IPv6 `::1`,
 * where a server bound to 127.0.0.1 isn't listening — the connection would be
 * refused.)
 *
 * `@@ <path>` file imports: only take effect when the server was started with
 * `daacini serve --imports-root <vault>` (opt-in, off by default — see that
 * flag's docs). A block with no `@@` line behaves exactly as before (plain
 * text body, plain SVG response) — the import path only activates for blocks
 * that use it, so this is a strict addition, not a behavior change for
 * existing notes.
 */
const { Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
  endpoint: "https://daacini.ijyalabs.in",
  syncTheme: true,
  lightTheme: "paper",
  darkTheme: "midnight",
};

// A top-level `theme:`/`palette:` directive the user may have set themselves.
const HAS_THEME = /^\s*(theme|palette)\s*[:=]/im;
// A `---`-separated block that is only `@@ <path>` — see cli/imports.ts (the
// server-side counterpart) for the full syntax. `.+` (not `\S+`) so a path
// with spaces (real note titles routinely have them) still trips the gate.
const HAS_IMPORT = /^\s*@@\s*.+\s*$/m;

/** Vault paths are always `/`-separated regardless of OS; a tiny inline
 *  dirname avoids pulling in Node's `path` module for a one-line need. */
function dirnameOf(vaultPath) {
  const i = vaultPath.lastIndexOf("/");
  return i === -1 ? "" : vaultPath.slice(0, i);
}

module.exports = class DaaCiniPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.cache = new Map();
    this.addSettingTab(new DaaCiniSettingTab(this.app, this));
    // "daacini" is the current fence language; "mermaid-pp" stays registered
    // too so notes written before the rename keep rendering unmodified.
    this.registerMarkdownCodeBlockProcessor("daacini", (src, el, ctx) => this.render(src, el, ctx));
    this.registerMarkdownCodeBlockProcessor("mermaid-pp", (src, el, ctx) => this.render(src, el, ctx));
    // Re-theming the app invalidates cached SVGs; blocks re-render on next view.
    this.registerEvent(this.app.workspace.on("css-change", () => this.cache.clear()));
  }

  onunload() {
    this.cache.clear();
  }

  // Prepend a theme directive that follows Obsidian's light/dark mode, unless the
  // author already chose a theme in the block.
  themed(source) {
    if (!this.settings.syncTheme || HAS_THEME.test(source)) return source;
    const dark = document.body.classList.contains("theme-dark");
    return `theme: ${dark ? this.settings.darkTheme : this.settings.lightTheme}\n${source}`;
  }

  async render(source, el, ctx) {
    el.empty();
    const wrap = el.createDiv({ cls: "daacini" });
    const body = this.themed(source);
    const withImports = HAS_IMPORT.test(source);
    const importBase = withImports && ctx && ctx.sourcePath ? dirnameOf(ctx.sourcePath) : "";
    // Only scope the cache key by note path when it can actually matter (an
    // import-bearing block resolves differently per note); a plain block still
    // shares its cache entry across every note that renders the same source.
    const cacheKey = withImports ? `${body}\n@base:${importBase}` : body;
    const cached = this.cache.get(cacheKey);
    if (cached) { this.paint(wrap, cached); return; }

    wrap.createDiv({ cls: "daacini-loading", text: "Rendering diagram…" });
    try {
      const base = this.settings.endpoint.replace(/\/+$/, "");
      const headers = withImports ? { Accept: "application/json", "X-Import-Base": importBase } : undefined;
      const res = await requestUrl({ url: base + "/render", method: "POST", contentType: "text/plain", headers, body, throw: false });
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(res.text).error || msg; } catch (_) { /* not JSON */ }
        throw new Error(msg);
      }
      // Imports request JSON back (single diagram → { kind, svg }, several →
      // { diagrams: [...] }); a plain block gets the raw SVG body as before.
      const items = withImports
        ? (JSON.parse(res.text).diagrams ?? [JSON.parse(res.text)]).map((d) => ({ svg: d.svg, kind: d.kind }))
        : [{ svg: res.text }];
      this.cache.set(cacheKey, items);
      this.paint(wrap, items);
    } catch (e) {
      wrap.empty();
      const err = wrap.createDiv({ cls: "daacini-error" });
      err.createEl("strong", { text: "DaaCini couldn't render this diagram" });
      err.createEl("div", { cls: "daacini-error-msg", text: String((e && e.message) || e) });
      const hint = withImports
        ? `Endpoint: ${this.settings.endpoint} — @@ imports need the server started with --imports-root <vault> (see the plugin README).`
        : `Endpoint: ${this.settings.endpoint} — is the service running (\`daacini serve\`)?`;
      err.createEl("small", { text: hint });
    }
  }

  paint(wrap, items) {
    wrap.empty();
    wrap.toggleClass("daacini-multi", items.length > 1);
    for (const [i, item] of items.entries()) {
      if (items.length > 1) {
        wrap.createDiv({ cls: "daacini-label", text: `${i + 1} / ${items.length}${item.kind ? " · " + item.kind : ""}` });
      }
      const holder = wrap.createDiv({ cls: "daacini-item" });
      // Parse the returned SVG as XML and append the element (rather than
      // assigning raw markup) — the service is trusted, but this is the safer
      // DOM-building pattern and keeps the SVG namespace intact.
      const doc = new DOMParser().parseFromString(item.svg, "image/svg+xml");
      const svgEl = doc.documentElement;
      if (svgEl && svgEl.nodeName.toLowerCase() === "svg") holder.appendChild(svgEl);
      else holder.setText("could not parse the rendered SVG");
    }
  }

  async saveSettings() { await this.saveData(this.settings); }
};

class DaaCiniSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "IjyaLabs DaaCini" });

    new Setting(containerEl)
      .setName("Service endpoint")
      .setDesc("An IjyaLabs DaaCini server. The hosted IjyaLabs service (default), or your own `daacini serve` for local/private rendering. A loopback address keeps note content on your machine. Use 127.0.0.1 rather than localhost on dual-stack hosts.")
      .addText((t) => t
        .setPlaceholder("https://daacini.ijyalabs.in")
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (v) => { this.plugin.settings.endpoint = v.trim() || DEFAULT_SETTINGS.endpoint; await this.plugin.saveSettings(); this.plugin.cache.clear(); }));

    new Setting(containerEl)
      .setName("Match Obsidian light/dark")
      .setDesc("Add a theme directive so diagrams follow the app theme (unless the block sets its own).")
      .addToggle((t) => t
        .setValue(this.plugin.settings.syncTheme)
        .onChange(async (v) => { this.plugin.settings.syncTheme = v; await this.plugin.saveSettings(); this.plugin.cache.clear(); }));

    new Setting(containerEl)
      .setName("Light theme")
      .setDesc("DaaCini theme name/number for light mode (e.g. paper, mist, sky, candy or 1–4).")
      .addText((t) => t
        .setValue(this.plugin.settings.lightTheme)
        .onChange(async (v) => { this.plugin.settings.lightTheme = v.trim() || "paper"; await this.plugin.saveSettings(); this.plugin.cache.clear(); }));

    new Setting(containerEl)
      .setName("Dark theme")
      .setDesc("DaaCini theme name/number for dark mode (e.g. slate, dusk, midnight, carbon or 5–8).")
      .addText((t) => t
        .setValue(this.plugin.settings.darkTheme)
        .onChange(async (v) => { this.plugin.settings.darkTheme = v.trim() || "midnight"; await this.plugin.saveSettings(); this.plugin.cache.clear(); }));
  }
}
