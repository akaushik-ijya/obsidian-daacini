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
const { Plugin, PluginSettingTab, Setting, requestUrl, Notice, MarkdownPreviewRenderer } = require("obsidian");

const DEFAULT_SETTINGS = {
  // ⛔ AN ORDERED LIST, AND THE ORDER IS THE POINT — one endpoint could not express what a real
  // vault needs. A name that resolves on your own network reaches the very same service the
  // public name serves, so a diagram can be rendered (and that service TESTED) without the
  // request leaving the LAN and coming back through the public edge; the public name is the
  // fallback for when you are not on that network. And a `@@` block needs something neither
  // can do — see `post()` — so a machine running `daacini serve --imports-root <vault>` belongs
  // in the list too. One per line, tried top to bottom.
  endpoints: "http://daacini.local.ijyalabs.in:4184\nhttps://daacini.ijyalabs.in",
  syncTheme: true,
  lightTheme: "paper",
  darkTheme: "midnight",
};

/** A refusal that means "not here, but maybe elsewhere" rather than "your diagram is wrong".
 *  The server types it, so this is a code comparison and not prose-matching: a `@@` block sent
 *  to a service with no `--imports-root` is refused with exactly this, and a service started
 *  with one will answer it. Every OTHER refusal stops the search. */
const TRY_NEXT_CODE = "import-not-resolvable-here";

/** How long an endpoint that failed to answer is not retried, in ms. Off the LAN a local name
 *  does not resolve, and paying that failure on every single block would make the whole note
 *  render at the speed of a DNS timeout. One failure parks it; the next render after this
 *  window tries again, so walking back onto the network needs no setting change. */
const RETRY_AFTER_MS = 60_000;

// A top-level `theme:`/`palette:` directive the user may have set themselves.
const HAS_THEME = /^\s*(theme|palette)\s*[:=]/im;
// A `---`-separated block that is only `@@ <path>` — see cli/imports.ts (the
// server-side counterpart) for the full syntax. `.+` (not `\S+`) so a path
// with spaces (real note titles routinely have them) still trips the gate.
const HAS_IMPORT = /^\s*@@\s*.+\s*$/m;

/** Vault paths are always `/`-separated regardless of OS; a tiny inline
 *  dirname avoids pulling in Node's `path` module for a one-line need. */
/** Is this fence language already registered by some other plugin?
 *  Reads the renderer's own registry, which is the same map its register call
 *  checks — so this cannot disagree with it. Unreadable (older or mobile build)
 *  answers "no" and leaves the try/catch in claimFence to cover it. */
function fenceTaken(lang) {
  const map = MarkdownPreviewRenderer && MarkdownPreviewRenderer.codeBlockPostProcessors;
  if (!map || typeof map !== "object") return false;
  return Object.prototype.hasOwnProperty.call(map, lang);
}

function dirnameOf(vaultPath) {
  const i = vaultPath.lastIndexOf("/");
  return i === -1 ? "" : vaultPath.slice(0, i);
}

/** Fence languages this plugin renders, primary first. */
const FENCES = ["daacini", "mermaid-pp"];

module.exports = class DaaCiniPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.cache = new Map();
    this.addSettingTab(new DaaCiniSettingTab(this.app, this));
    // "daacini" is the current fence language; "mermaid-pp" stays registered
    // too so notes written before the rename keep rendering unmodified.
    this.claimed = [];
    this.taken = [];
    for (const lang of FENCES) this.claimFence(lang);
    if (!this.claimed.length) {
      new Notice(`DaaCini: every fence it renders (${FENCES.join(", ")}) is already owned by `
        + `another plugin. Disable that plugin, or DaaCini will render nothing.`, 15000);
    }
    // Re-theming the app invalidates cached SVGs; blocks re-render on next view.
    this.registerEvent(this.app.workspace.on("css-change", () => this.cache.clear()));
  }

  onunload() {
    this.cache.clear();
  }

  /** Claim one fence language, yielding to whoever already has it.
   *
   *  ⛔ A FENCE IS A SHARED NAMESPACE AND OBSIDIAN THROWS OVER IT. Since 1.13
   *  `MarkdownPreviewRenderer.registerCodeBlockPostProcessor` throws
   *  "Code block postprocessor for language X is already registered" — so calling
   *  `registerMarkdownCodeBlockProcessor` for a language another enabled plugin owns
   *  does not lose that one fence, it throws out of `onload` and Obsidian reports
   *  "Failed to load plugin daacini". The whole plugin dies over a legacy alias.
   *  That is exactly what the vault hit: mermaid-pp v0.2.1 owns `mermaid-pp`.
   *
   *  ⛔ AND THE FAILED CALL LEAKS. Obsidian registers the post-processor BEFORE the
   *  line that throws and registers its teardown AFTER, so a caught exception leaves a
   *  live processor with no unregister — running this plugin's render on every such
   *  block for the rest of the session, alongside the owner's. So ASK FIRST and only
   *  fall back to try/catch if the registry cannot be read; never rely on the catch.
   */
  claimFence(lang) {
    if (fenceTaken(lang)) { this.taken.push(lang); return false; }
    try {
      this.registerMarkdownCodeBlockProcessor(lang, (src, el, ctx) => this.render(src, el, ctx));
      this.claimed.push(lang);
      return true;
    } catch (e) {
      this.taken.push(lang);
      console.warn(`[daacini] the \`${lang}\` fence is already claimed by another plugin`, e);
      return false;
    }
  }

  // Prepend a theme directive that follows Obsidian's light/dark mode, unless the
  // author already chose a theme in the block.
  themed(source) {
    if (!this.settings.syncTheme || HAS_THEME.test(source)) return source;
    const dark = document.body.classList.contains("theme-dark");
    return `theme: ${dark ? this.settings.darkTheme : this.settings.lightTheme}\n${source}`;
  }

  /** Every endpoint the author configured, in order, minus the ones currently parked.
   *
   *  ⛔ MIGRATED, NOT RESET. Earlier versions stored a single `endpoint`; reading only the new
   *  field would silently move a vault pointing at its own `daacini serve` onto the hosted
   *  service — the exact substitution this repo keeps finding, and here it would send note
   *  content somewhere the author had deliberately kept it from. */
  configured() {
    const clean = (v) => String(v || "").trim().replace(/\/+$/, "");
    const raw = this.settings.endpoints !== undefined && String(this.settings.endpoints).trim()
      ? String(this.settings.endpoints)
      : [this.settings.localEndpoint, this.settings.endpoint].filter(Boolean).join("\n");
    const out = [];
    for (const one of raw.split(/[\n,]/).map(clean)) if (one && !out.includes(one)) out.push(one);
    return out.length ? out : [clean(DEFAULT_SETTINGS.endpoints.split("\n").pop())];
  }

  /** Those not currently parked — and never an empty list, because a note that renders nothing
   *  and explains nothing is worse than one that shows the failure it actually got. */
  endpoints() {
    const all = this.configured();
    const now = Date.now();
    const live = all.filter((b) => !((this.parked || {})[b] > now));
    return live.length ? live : all;
  }

  /** POST to the first endpoint that ANSWERS, and return its answer with the base that gave it.
   *
   *  ⛔ AN HTTP ERROR IS AN ANSWER, NOT A REASON TO FAIL OVER. A 400 means this service read
   *  the document and refused it; retrying the same document against the next endpoint would
   *  send it out of the network to be refused again, and would turn a local-only render into a
   *  public one on the strength of the author's own syntax error. Only an endpoint that cannot
   *  be REACHED — where `requestUrl` throws rather than responding — moves to the next one.
   */
  async post(path, body, headers) {
    const bases = this.endpoints();
    let lastErr = null, lastRes = null, lastBase = null;
    for (const base of bases) {
      let res;
      try {
        res = await requestUrl({ url: base + path, method: "POST", contentType: "text/plain", headers, body, throw: false });
      } catch (e) {
        lastErr = e;
        // Park it, so the rest of this note does not re-pay the same timeout per block.
        this.parked = Object.assign({}, this.parked, { [base]: Date.now() + RETRY_AFTER_MS });
        continue;
      }
      lastRes = res; lastBase = base;
      // ⛔ THE ONE REFUSAL THAT MEANS "ASK SOMEONE ELSE". A `@@` block sent to a service with no
      // `--imports-root` is refused with a typed code — and a hosted service can never have one,
      // because `daacini serve` refuses `--hosted` and `--imports-root` together. So a vault
      // whose notes import files needs a machine that can read them IN THE LIST, and this is
      // what walks to it. Any other 4xx is about the document and stops here.
      if (res.status !== 200 && this.codeOf(res) === TRY_NEXT_CODE) continue;
      return { res, base };
    }
    // Everything refused it for the same capability reason: hand back the last real answer, so
    // the note shows the server's own explanation rather than a connection error it never had.
    if (lastRes) return { res: lastRes, base: lastBase };
    throw lastErr || new Error(`no endpoint answered (tried ${bases.join(", ")})`);
  }

  /** The typed `code` on a refusal, or null. */
  codeOf(res) {
    try { return JSON.parse(res.text).code ?? null; } catch (_) { return null; }
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
    // ⛔ THE HINT MUST NAME THE ENDPOINT THAT ACTUALLY SERVED. With two endpoints tried in
    // order, "is the service running" against a name the request never reached sends the
    // reader to the wrong machine — the failure they need to see is the one that answered.
    let served = null;
    try {
      const headers = withImports ? { Accept: "application/json", "X-Import-Base": importBase } : undefined;
      const { res, base } = await this.post("/render", body, headers);
      served = base;
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`;
        // ⛔ THE TYPED REASON REACHES THE NOTE. A refusal carries `{ code, observed }`;
        // keeping only the sentence meant a reader could not tell a diagram they must fix
        // from a service that was briefly busy — the one case where the answer is "wait".
        let body = null;
        try { body = JSON.parse(res.text); msg = body.error || msg; } catch (_) { /* not JSON */ }
        const err = new Error([429, 502, 503, 504].includes(res.status)
          ? `${msg} — the service was busy; this is not a problem with your diagram. Try again in a moment.`
          : msg);
        err.status = res.status;
        if (body && body.code) err.code = body.code;
        if (body && body.observed) err.observed = body.observed;
        throw err;
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
      const where = served || `none of ${this.endpoints().join(", ")}`;
      const hint = withImports
        ? `Endpoint: ${where} — @@ imports need the server started with --imports-root <vault>; a hosted service cannot serve them at all. Remote URLs also need --remote-import-allow <literal-ip> (see the plugin README).`
        : served
          ? `Endpoint: ${served} — it answered, so this is the diagram or the service, not the connection.`
          : `Tried ${this.endpoints().join(", ")} — none answered. Is a service running (\`daacini serve\`), and is the local name resolving?`;
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

// The twelve shipped themes, offered as a DROPDOWN rather than free text.
// These were text fields whose help said "paper, mist, sky, candy or 1–4" —
// under-advertising by two thirds, and accepting anything: an unrecognised name
// is rejected nowhere, so resolveTheme falls back to  and a typo renders
// the default while appearing to have been applied. A dropdown makes the typo
// impossible and the other eight themes discoverable.
// Kept in step with core/theme.ts by tests/obsidian-settings-vocabulary.test.mjs.
const THEME_CHOICES = [
  ["paper", "paper — light"],
  ["mist", "mist — light"],
  ["sky", "sky — light"],
  ["candy", "candy — light"],
  ["slate", "slate — dark"],
  ["dusk", "dusk — dark"],
  ["midnight", "midnight — dark"],
  ["carbon", "carbon — dark"],
  ["mono-light", "mono-light — light"],
  ["mono-dark", "mono-dark — dark"],
  ["contrast-light", "contrast-light — light"],
  ["contrast-dark", "contrast-dark — dark"],
];

class DaaCiniSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "IjyaLabs DaaCini" });

    // A fence another plugin owns renders through THAT plugin, silently — so say so
    // here, where someone wondering why a block looks wrong will actually look.
    const taken = this.plugin.taken || [];
    if (taken.length) {
      const warn = containerEl.createEl("p", {
        text: `Not rendering ${taken.map((l) => "\u0060" + l + "\u0060").join(" or ")}: `
          + `another enabled plugin already claims ${taken.length > 1 ? "those fences" : "that fence"}. `
          + `Blocks in ${taken.length > 1 ? "those languages" : "that language"} are rendered by it, not by DaaCini. `
          + `Disable that plugin — its id is usually \u0060mermaid-pp\u0060 — and reload to hand `
          + `${taken.length > 1 ? "them" : "it"} over.`,
      });
      warn.style.color = "var(--text-warning)";
    }

    new Setting(containerEl)
      .setName("Service endpoints")
      .setDesc("One per line, tried top to bottom. A name on your own network reaches a service without the request leaving it; the hosted service is the fallback for when you are not on that network. A `@@` import needs a service started with --imports-root — a hosted one can never have that — so if your notes import files, list the machine that can read them too; a block it cannot serve walks to the next endpoint on its own. Use 127.0.0.1 rather than localhost on dual-stack hosts.")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
        return t
          .setPlaceholder(DEFAULT_SETTINGS.endpoints)
          .setValue(this.plugin.configured().join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.endpoints = v;
            this.plugin.parked = {};                  // a deliberate change deserves an immediate try
            await this.plugin.saveSettings();
            this.plugin.cache.clear();
          });
      });

    new Setting(containerEl)
      .setName("Match Obsidian light/dark")
      .setDesc("Add a theme directive so diagrams follow the app theme (unless the block sets its own).")
      .addToggle((t) => t
        .setValue(this.plugin.settings.syncTheme)
        .onChange(async (v) => { this.plugin.settings.syncTheme = v; await this.plugin.saveSettings(); this.plugin.cache.clear(); }));

    new Setting(containerEl)
      .setName("Light theme")
      .setDesc("DaaCini theme for light mode.")
      .addDropdown((d) => {
        for (const [value, label] of THEME_CHOICES) d.addOption(value, label);
        return d
          .setValue(this.plugin.settings.lightTheme)
          .onChange(async (v) => { this.plugin.settings.lightTheme = v || "paper"; await this.plugin.saveSettings(); this.plugin.cache.clear(); });
      });

    new Setting(containerEl)
      .setName("Dark theme")
      .setDesc("DaaCini theme for dark mode.")
      .addDropdown((d) => {
        for (const [value, label] of THEME_CHOICES) d.addOption(value, label);
        return d
          .setValue(this.plugin.settings.darkTheme)
          .onChange(async (v) => { this.plugin.settings.darkTheme = v || "midnight"; await this.plugin.saveSettings(); this.plugin.cache.clear(); });
      });
  }
}
