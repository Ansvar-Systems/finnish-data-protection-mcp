#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDataFreshness,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "finnish-data-protection-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "fi_dp_search_decisions",
    description:
      "Full-text search across TSV decisions (päätökset, seuraamusmaksut, huomautukset). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Finnish (e.g., 'suostumus evästeet', 'Taksi Helsinki')" },
        type: {
          type: "string",
          enum: ["seuraamusmaksu", "paatos", "huomautus", "lausunto"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "fi_dp_get_decision",
    description:
      "Get a specific TSV decision by reference number (e.g., 'TSV/2021/4949').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "TSV decision reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "fi_dp_search_guidelines",
    description:
      "Search TSV guidance documents: ohjeet, suositukset, and kannanotot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Finnish" },
        type: {
          type: "string",
          enum: ["ohje", "suositus", "kannanotto", "FAQ"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "fi_dp_get_guideline",
    description: "Get a specific TSV guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "fi_dp_list_topics",
    description: "List all covered data protection topics with Finnish and English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fi_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fi_dp_list_sources",
    description:
      "Return the canonical data source URLs and descriptions for this MCP server. Use this to verify provenance or link users to primary sources.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fi_dp_check_data_freshness",
    description:
      "Return the current row counts and latest record dates for decisions and guidelines in the database. Use this to assess how up-to-date the data is before citing it.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["seuraamusmaksu", "paatos", "huomautus", "lausunto"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["ohje", "suositus", "kannanotto", "FAQ"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- Shared _meta block (required on every response per golden standard) -----

const RESPONSE_META = {
  disclaimer:
    "This data is provided for informational purposes only and does not constitute legal advice. Verify against primary sources at tietosuoja.fi before relying on it.",
  copyright:
    "Tietosuojavaltuutetun toimisto (Finnish Data Protection Ombudsman). Sourced from public government publications.",
  source_url: "https://tietosuoja.fi/",
  data_age:
    "Use fi_dp_check_data_freshness to retrieve current row counts and latest record dates.",
} as const;

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      const payload =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? { ...(data as Record<string, unknown>), _meta: RESPONSE_META }
          : { data, _meta: RESPONSE_META };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "fi_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({ query: parsed.query, type: parsed.type, topic: parsed.topic, limit: parsed.limit });
          return textContent({ results, count: results.length });
        }
        case "fi_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) return errorContent(`Decision not found: ${parsed.reference}`);
          const decisionRecord = decision as Record<string, unknown>;
          return textContent({
            ...decisionRecord,
            _citation: buildCitation(
              String(decisionRecord["reference"] ?? parsed.reference),
              String(decisionRecord["title"] ?? decisionRecord["reference"] ?? parsed.reference),
              "fi_dp_get_decision",
              { reference: parsed.reference },
              decisionRecord["url"] as string | undefined,
            ),
          });
        }
        case "fi_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({ query: parsed.query, type: parsed.type, topic: parsed.topic, limit: parsed.limit });
          return textContent({ results, count: results.length });
        }
        case "fi_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) return errorContent(`Guideline not found: id=${parsed.id}`);
          const guidelineRecord = guideline as Record<string, unknown>;
          return textContent({
            ...guidelineRecord,
            _citation: buildCitation(
              String(guidelineRecord["reference"] ?? guidelineRecord["id"] ?? parsed.id),
              String(guidelineRecord["title"] ?? guidelineRecord["reference"] ?? `Guideline ${parsed.id}`),
              "fi_dp_get_guideline",
              { id: String(parsed.id) },
              guidelineRecord["url"] as string | undefined,
            ),
          });
        }
        case "fi_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length });
        }
        case "fi_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description: "Tietosuojavaltuutetun toimisto (Finnish Data Protection Ombudsman) MCP server. Provides access to Finnish data protection authority decisions, seuraamusmaksut, päätökset, and official guidance documents.",
            data_source: "Tietosuojavaltuutetun toimisto (https://tietosuoja.fi/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }
        case "fi_dp_list_sources": {
          return textContent({
            sources: [
              {
                id: "tietosuoja_decisions",
                name: "TSV Decisions (Päätökset)",
                url: "https://tietosuoja.fi/paatokset",
                description:
                  "Finnish Data Protection Ombudsman enforcement decisions, sanctions (seuraamusmaksut), and notices (huomautukset)",
              },
              {
                id: "tietosuoja_guidelines",
                name: "TSV Guidelines (Ohjeet ja suositukset)",
                url: "https://tietosuoja.fi/ohjeet-ja-julkaisut",
                description:
                  "Official guidance documents (ohjeet), recommendations (suositukset), and FAQ documents on GDPR implementation",
              },
            ],
          });
        }
        case "fi_dp_check_data_freshness": {
          const freshness = getDataFreshness();
          return textContent(freshness);
        }
        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
