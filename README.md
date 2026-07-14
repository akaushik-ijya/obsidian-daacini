# DaaCini for Obsidian

Render **[DaaCini](https://daacini.ijyalabs.in)** diagrams-as-code — network, cloud,
security, architecture, and 24 more kinds — live inside your notes. Write a fenced
block and it renders in Reading view:

<pre>
```daacini
network
title: Web Service
Users -> Load Balancer
Load Balancer -> Web A
Load Balancer -> Web B
Web A -> DB @primary
Web B -> DB
```
</pre>

## How it works — please read

This plugin is a **thin client**. It does **not** render diagrams locally: it sends
the text of each ` ```daacini ` block to the **DaaCini rendering service** over the
network and displays the SVG that comes back (source in → SVG out).

- **By default** it uses the hosted IjyaLabs service, `https://daacini.ijyalabs.in`.
- **Your diagram source is transmitted** to that service to be rendered. It may be
  retained briefly for debugging (see the [service privacy policy](https://daacini.ijyalabs.in/apps/daacini-policy/)).
  **Do not put secrets** (passwords, tokens, private keys) in a diagram.
- **Prefer to keep everything local/private?** Run your own server — `daacini serve`
  (Docker image available) — and set the **Service endpoint** in this plugin's
  settings to your own host (e.g. `http://127.0.0.1:4180`). Nothing then leaves your
  machine or network.

Only the text inside ` ```daacini ` (and legacy ` ```mermaid-pp `) blocks is ever sent —
the rest of your note is never read or transmitted.

## Settings

- **Service endpoint** — the DaaCini server to render against (hosted by default, or your own).
- **Match Obsidian light/dark** — prepend a theme so diagrams follow your app theme.

## Install

Community plugins (once listed): search **“DaaCini”** in *Settings → Community plugins → Browse*.

Manual: copy `main.js`, `manifest.json`, `styles.css` from the latest
[release](https://github.com/akaushik-ijya/obsidian-daacini/releases) into
`<vault>/.obsidian/plugins/daacini/`, then enable it under *Community plugins*.

## Support

`daacini@ijyalabs.in` (support/feedback) · `legal@ijlabs.in` (licensing).
Personal & private use; no commercial use or redistribution — see LICENSE.
