import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PortalClient, validateConfig } from "./portal.ts";
import { buildTools } from "./tools.ts";

let config: { baseUrl: string; token: string };
try {
  config = validateConfig(process.env);
} catch (e) {
  process.stderr.write(`texdy MCP server: ${(e as Error).message}\n`);
  process.exit(1);
}

const server = new McpServer({ name: "texdy", version: "0.1.0" });
const tools = buildTools(new PortalClient(config.baseUrl, config.token));
for (const [name, def] of Object.entries(tools)) {
  server.registerTool(
    name,
    { description: def.description, inputSchema: def.inputSchema },
    (args: unknown) => def.handler(args),
  );
}

await server.connect(new StdioServerTransport());
