import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PortalClient, validateConfig } from "./portal.ts";
import { buildTools } from "./tools.ts";
import { PLUGIN_VERSION, startUpdateCheck, withUpdateNotice } from "./update.ts";

let config: { baseUrl: string; token: string };
try {
  config = validateConfig(process.env);
} catch (e) {
  process.stderr.write(`mimosoid MCP server: ${(e as Error).message}\n`);
  process.exit(1);
}

const server = new McpServer({ name: "mimosoid", version: PLUGIN_VERSION });
// the first tool result of a session says so when a newer plugin is published (switch off: MIMOSOID_NO_UPDATE_CHECK=1)
const getUpdateNotice = startUpdateCheck({ current: PLUGIN_VERSION, env: process.env });
const tools = withUpdateNotice(buildTools(new PortalClient(config.baseUrl, config.token)), getUpdateNotice);
for (const [name, def] of Object.entries(tools)) {
  server.registerTool(
    name,
    { description: def.description, inputSchema: def.inputSchema },
    (args: unknown) => def.handler(args),
  );
}

await server.connect(new StdioServerTransport());
