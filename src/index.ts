#!/usr/bin/env node

/**
 * Finnish Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying Tietosuojavaltuutetun toimisto decisions,
 * sanctions, and data protection guidance documents.
 *
 * Tool prefix: fi_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDataFreshness,
} from "./db.js";
import { attachCitationsToSearchResults, buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "finnish-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "fi_dp_search_decisions",
    description:
      "Full-text search across Tietosuojavaltuutetun toimisto decisions (päätökset, seuraamusmaksut, huomautukset). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Finnish (e.g., 'suostumus evästeet', 'kameravalvonta', 'Taksi Helsinki')",
        },
        type: {
          type: "string",
          enum: ["seuraamusmaksu", "paatos", "huomautus", "lausunto"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'suostumus', 'evästeet', 'siirrot'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fi_dp_get_decision",
    description:
      "Get a specific TSV decision by reference number (e.g., 'TSV/2021/4949', 'TSV/2022/1234').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "TSV decision reference (e.g., 'TSV/2021/4949', 'TSV/2022/1234')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "fi_dp_search_guidelines",
    description:
      "Search Tietosuojavaltuutetun toimisto guidance documents: ohjeet, suositukset, and kannanotot. Covers GDPR implementation, DPIA methodology, cookie consent, kameravalvonta, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Finnish (e.g., 'evästeet', 'vaikutustenarviointi', 'rekisteröidyn oikeudet')",
        },
        type: {
          type: "string",
          enum: ["ohje", "suositus", "kannanotto", "FAQ"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'vaikutustenarviointi', 'evästeet', 'siirrot'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fi_dp_get_guideline",
    description:
      "Get a specific TSV guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from fi_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "fi_dp_list_topics",
    description:
      "List all covered data protection topics with Finnish and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fi_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fi_dp_list_sources",
    description:
      "Return the canonical data source URLs and descriptions for this MCP server. Use this to verify provenance or link users to primary sources.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fi_dp_check_data_freshness",
    description:
      "Return the current row counts and latest record dates for decisions and guidelines in the database. Use this to assess how up-to-date the data is before citing it.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  const payload =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as unknown as Record<string, unknown>), _meta: RESPONSE_META }
      : { data, _meta: RESPONSE_META };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "fi_dp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const rows = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        const results = attachCitationsToSearchResults(
          rows as unknown as Array<Record<string, unknown>>,
          "fi_dp_search_decisions",
          (row) => ({
            canonical_ref: String(row["reference"] ?? ""),
            display_text: String(
              row["title"] ?? row["reference"] ?? "(untitled)",
            ),
            lookup_args: {
              reference: String(row["reference"] ?? ""),
            },
            source_url:
              typeof row["source_url"] === "string"
                ? (row["source_url"] as string)
                : null,
          }),
        );
        return textContent({ results, count: results.length });
      }

      case "fi_dp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.reference);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`);
        }
        const decisionRecord = decision as unknown as Record<string, unknown>;
        const sourceUrl =
          typeof decisionRecord["source_url"] === "string"
            ? (decisionRecord["source_url"] as string)
            : null;
        return textContent({
          ...decisionRecord,
          _citation: buildCitation(
            String(decisionRecord.reference ?? parsed.reference),
            String(decisionRecord.title ?? decisionRecord.reference ?? parsed.reference),
            "fi_dp_get_decision",
            { reference: parsed.reference },
            sourceUrl,
          ),
        });
      }

      case "fi_dp_search_guidelines": {
        const parsed = SearchGuidelinesArgs.parse(args);
        const rows = searchGuidelines({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        const results = attachCitationsToSearchResults(
          rows as unknown as Array<Record<string, unknown>>,
          "fi_dp_search_guidelines",
          (row) => ({
            canonical_ref: String(row["reference"] ?? row["id"] ?? ""),
            display_text: String(
              row["title"] ?? row["reference"] ?? `Guideline ${row["id"]}`,
            ),
            lookup_args: {
              id: String(row["id"] ?? ""),
            },
            source_url:
              typeof row["source_url"] === "string"
                ? (row["source_url"] as string)
                : null,
          }),
        );
        return textContent({ results, count: results.length });
      }

      case "fi_dp_get_guideline": {
        const parsed = GetGuidelineArgs.parse(args);
        const guideline = getGuideline(parsed.id);
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`);
        }
        const guidelineRecord = guideline as unknown as Record<string, unknown>;
        const sourceUrl =
          typeof guidelineRecord["source_url"] === "string"
            ? (guidelineRecord["source_url"] as string)
            : null;
        return textContent({
          ...guidelineRecord,
          _citation: buildCitation(
            String(guidelineRecord.reference ?? guidelineRecord.id ?? parsed.id),
            String(guidelineRecord.title ?? guidelineRecord.reference ?? `Guideline ${parsed.id}`),
            "fi_dp_get_guideline",
            { id: String(parsed.id) },
            sourceUrl,
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
          description:
            "Tietosuojavaltuutetun toimisto (Finnish Data Protection Ombudsman) MCP server. Provides access to Finnish data protection authority decisions, seuraamusmaksut, päätökset, and official guidance documents.",
          data_source: "Tietosuojavaltuutetun toimisto (https://tietosuoja.fi/)",
          coverage: {
            decisions: "TSV päätökset, seuraamusmaksut, and huomautukset",
            guidelines: "TSV ohjeet, suositukset, and kannanotot",
            topics: "Evästeet, terveydenhuolto, suostumus, rekisteröidyn oikeudet, vaikutustenarviointi, siirrot, kameravalvonta, työntekijöiden tietosuoja, lapset",
          },
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
