# Texdy in your AI agent: install and use

Texdy comes with an MCP server. Once an AI agent has it, you can say "draw the login flow as a sequence diagram" and the agent writes the PlantUML, checks that it renders, saves it in your Texdy and opens the editor on it. You then edit the diagram in the editor as usual and tell the agent "review my changes".

Claude Code gets the full experience through a plugin (MCP server plus a skill that teaches Claude the workflow). Any other agent that supports MCP servers can use the same server; see [Other agents](#other-agents).

## 1. What you need

1. **Node.js 20 or newer** on the machine where the agent runs (`node -v`). The MCP server is one file, `claude-plugin/server/dist/server.mjs`; there is nothing to install or build.
2. **The plugin files.** They are in the public repository <https://github.com/rborisov/texdy-plugin>. Claude Code fetches them by itself (section 2). Any other agent needs a clone that stays where it is, because the agent runs a file from it (`git pull` updates it):

   ```bash
   git clone https://github.com/rborisov/texdy-plugin.git
   ```
3. **The portal address.** The base URL of your Texdy including the `/uml` prefix and without a trailing slash, for example `https://d.rclmx.info/uml`.
4. **A personal API token.** Open Texdy in the browser, sign in, press **API tokens** in the toolbar, give the token a name (for example `claude on laptop`) and a lifetime, and copy the `umlp_...` value. It is shown only once. Make one token per agent or machine, so you can revoke one without breaking the others.

The portal must be a version with API tokens (ask whoever runs it to deploy the latest one first).

## 2. Claude Code (terminal, desktop app, IDE)

### Install the plugin

Add the repository as a marketplace and install the plugin from it:

```bash
claude plugin marketplace add rborisov/texdy-plugin
claude plugin install uml-portal@uml-portal-marketplace
```

Inside a running session the same commands are `/plugin marketplace add ...` and `/plugin install uml-portal@uml-portal-marketplace`.

Claude Code then asks for two values:

- **Portal URL**: the address from step 1.3.
- **API token**: the `umlp_...` value. It is masked and kept in the system's secure credential store.

Start a **new session** (the MCP server is started when a session starts; `/reload-plugins` does not restart it).

### Check that it works

Ask: *"List my diagrams in Texdy."* Claude should call `list_diagrams` and answer with your diagrams (an empty list is fine for a new account). Then try: *"Draw a sequence diagram of a user logging in."* You should get a saved diagram, a file `diagrams/<slug>.svg` in your project, and the editor opening on it, already signed in.

If Claude does not know about Texdy at all, run `/plugin` and check that `uml-portal` is installed and enabled, then start a new session.

### Everyday use

- **Create:** "Draw ... as a component diagram." Claude renders it, fixes syntax errors on its own, saves it and gives you the path of the exported SVG and the editor.
- **Edit in the editor:** change the diagram in Texdy as usual. It saves by itself.
- **Hand the changes back:** tell Claude *"review my changes"* (or "I changed the diagram, update the SVG"). The portal does not notify the agent, so it only looks when you ask. Claude reads the current source, refreshes the exported file and reviews what you changed.
- **Change it with Claude:** "Add a cache between the API and the database." Claude always reads the current version first and never overwrites your edits; if you both changed it, it merges.
- **Open an existing diagram:** "Open the diagram 'login flow'." The link Claude uses signs the editor in with your token and works once, for about a minute.

### Change the URL or the token

```bash
claude plugin configure uml-portal@uml-portal-marketplace
```

shows which values are set; start a new session after changing them.

### Update

```bash
claude plugin marketplace update uml-portal-marketplace
claude plugin update uml-portal@uml-portal-marketplace
```

Then start a new session.

### Uninstall

```bash
claude plugin uninstall uml-portal@uml-portal-marketplace
```

Revoke the token in Texdy (**API tokens**) if you will not use it again.

### Without the plugin system

If your Claude Code cannot ask for the two values, register only the MCP server by hand (this does not add the skill, so Claude knows the tools but not the workflow; add the rules from [Rules for the agent](#rules-for-the-agent) to your `CLAUDE.md`):

```bash
claude mcp add --scope user uml-portal \
  -e UML_PORTAL_URL=https://d.rclmx.info/uml \
  -e UML_PORTAL_TOKEN=umlp_... \
  -- node /absolute/path/to/texdy-plugin/server/dist/server.mjs
```

The token is then stored in plain text in your Claude configuration. This needs a clone of the repository (section 1, item 2).

## Other agents

Any agent that can start a **stdio MCP server** works. The server is always the same command with two environment variables:

| Setting | Value |
|---|---|
| command | `node` |
| arguments | `/absolute/path/to/texdy-plugin/server/dist/server.mjs` |
| env `UML_PORTAL_URL` | `https://d.rclmx.info/uml` (your portal, no trailing slash) |
| env `UML_PORTAL_TOKEN` | `umlp_...` |

Use absolute paths; many agents do not start the server in your project folder. Put the settings where your agent keeps its MCP servers. The usual places (check your agent's documentation if it changed):

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "uml-portal": {
      "command": "node",
      "args": ["/absolute/path/to/texdy-plugin/server/dist/server.mjs"],
      "env": { "UML_PORTAL_URL": "https://d.rclmx.info/uml", "UML_PORTAL_TOKEN": "umlp_..." }
    }
  }
}
```

**Claude Desktop**: the same `mcpServers` block in `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart the app.

**Windsurf**: the same block in `~/.codeium/windsurf/mcp_config.json`. **Gemini CLI**: the same block in `~/.gemini/settings.json`.

**VS Code (Copilot agent mode)**: `.vscode/mcp.json`, note `servers` instead of `mcpServers`:

```json
{
  "servers": {
    "uml-portal": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/texdy-plugin/server/dist/server.mjs"],
      "env": { "UML_PORTAL_URL": "https://d.rclmx.info/uml", "UML_PORTAL_TOKEN": "umlp_..." }
    }
  }
}
```

**Codex CLI**: `~/.codex/config.toml`:

```toml
[mcp_servers.uml-portal]
command = "node"
args = ["/absolute/path/to/texdy-plugin/server/dist/server.mjs"]
env = { UML_PORTAL_URL = "https://d.rclmx.info/uml", UML_PORTAL_TOKEN = "umlp_..." }
```

Restart the agent after saving. These files hold the token in plain text: do not commit a project-level file that contains it (put the file in `.gitignore`, or use the user-level file).

The config formats above are the ones these tools document; only Claude Code has been tried with Texdy so far.

### Rules for the agent

Other agents have no skill, so tell them the workflow once, in the file they read for instructions (`AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`, `GEMINI.md`). Copy the text of [`agent-rules.md`](agent-rules.md) into it (the same text is shown in the portal, in the **API tokens** dialog).

## What the tools do

| Tool | What it does |
|---|---|
| `render_diagram` | Checks PlantUML without saving; returns the picture, or errors with line numbers |
| `create_diagram` | Saves a new diagram; returns slug, version and link |
| `get_diagram` | Returns title, version, link and source |
| `update_diagram` | Replaces the source; needs `base_version`, refuses to overwrite someone else's change |
| `list_diagrams` | Lists your diagrams |
| `open_diagram` | A one-time link that opens the editor signed in |
| `export_diagram` | Saves an SVG (or PNG) into the project folder with the diagram's source, slug and version embedded in the file |

An exported SVG or PNG carries its own source, so you can open it, see which diagram and version it came from, and recover the source from it.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| The agent does not list the Texdy tools | The agent was not restarted after the config change, `node` is older than 20 or not on the agent's `PATH`, or the path to `server.mjs` is wrong or relative. Use `node -v` and an absolute path. |
| `401` / "Unauthorized" | The token is wrong, expired or revoked. Make a new one in **API tokens** and update the setting. |
| A message mentioning a redirect (301, 302, 307, 308) and `UML_PORTAL_URL` | The URL is wrong: usually the `/uml` prefix is missing, or `http` was used where the portal wants `https`. The server never follows redirects, so the token is never sent anywhere else. |
| "plain http" is refused | Only `localhost` may use `http`. Use the `https` address. |
| Connection refused or timed out | The portal is not reachable from this machine (VPN, firewall) or the address has a typo. |
| "Diagram changed elsewhere" (409) | You edited it in the editor while the agent worked. The agent should merge and retry; if it asks you, say "merge, keep my edits". |
| The editor shows "Sign-in link expired" | The one-time link lasts about a minute. Ask the agent to open the diagram again. |
| The editor asks for a password | The link was already used, or it was not opened in time. Ask for a fresh one, or sign in normally with your portal account. |
| "This sign-in link is for another account" | Your browser is signed in to Texdy as someone else. Log out of Texdy there and open the link again. |
| The editor does not start at `http://localhost:8080` | The editor is served under `/uml/`. For a local setup use the Vite dev server (`http://localhost:5173/uml/`). |

## Security

- The token can read and change every diagram of your account. Treat it like a password; one token per agent; revoke it in **API tokens** when you stop using that agent or lose the machine.
- The one-time link signs the editor in for up to 7 days in that browser, with limited rights (no token management). Revoking the token signs it out.
- The server only talks to the portal address you configured, over `https` (or `http` on `localhost`).


## About this repository

It is published from the Texdy project and replaced on every release: report problems here, but changes are made in the project. To build the server bundle yourself: `cd server && npm ci && npm test && npm run build` (Node.js 20 or newer).
