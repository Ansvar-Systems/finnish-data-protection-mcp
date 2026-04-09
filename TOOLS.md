# Tools Reference

This document describes all MCP tools exposed by the Finnish Data Protection MCP server.

**Tool prefix:** `fi_dp_`  
**Transport:** stdio (local) and Streamable HTTP (remote)

---

## fi_dp_search_decisions

Full-text search across TSV decisions (päätökset, seuraamusmaksut, huomautukset).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query in Finnish (e.g., `suostumus evästeet`, `Taksi Helsinki`) |
| `type` | string | No | Filter by decision type: `seuraamusmaksu`, `paatos`, `huomautus`, `lausunto` |
| `topic` | string | No | Filter by topic ID (e.g., `suostumus`, `evästeet`, `siirrot`) |
| `limit` | number | No | Maximum results to return. Default: 20, max: 100 |

**Returns:** `{ results: Decision[], count: number, _meta: ResponseMeta }`

---

## fi_dp_get_decision

Get a specific TSV decision by reference number.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | Yes | TSV decision reference (e.g., `TSV/2021/4949`, `TSV/2022/1234`) |

**Returns:** `Decision & { _citation: CitationMetadata, _meta: ResponseMeta }`

---

## fi_dp_search_guidelines

Search TSV guidance documents: ohjeet, suositukset, and kannanotot.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query in Finnish (e.g., `evästeet`, `vaikutustenarviointi`) |
| `type` | string | No | Filter by guidance type: `ohje`, `suositus`, `kannanotto`, `FAQ` |
| `topic` | string | No | Filter by topic ID |
| `limit` | number | No | Maximum results to return. Default: 20, max: 100 |

**Returns:** `{ results: Guideline[], count: number, _meta: ResponseMeta }`

---

## fi_dp_get_guideline

Get a specific TSV guidance document by its database ID.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Guideline database ID (from `fi_dp_search_guidelines` results) |

**Returns:** `Guideline & { _citation: CitationMetadata, _meta: ResponseMeta }`

---

## fi_dp_list_topics

List all covered data protection topics with Finnish and English names.

**Parameters:** None

**Returns:** `{ topics: Topic[], count: number, _meta: ResponseMeta }`

---

## fi_dp_about

Return metadata about this MCP server: version, data source, coverage, and tool list.

**Parameters:** None

**Returns:** Server metadata including name, version, description, data_source, coverage, and tools list.

---

## fi_dp_list_sources

Return the canonical data source URLs and descriptions for this MCP server.

**Parameters:** None

**Returns:**
```json
{
  "sources": [
    {
      "id": "tietosuoja_decisions",
      "name": "TSV Decisions (Päätökset)",
      "url": "https://tietosuoja.fi/paatokset",
      "description": "..."
    },
    {
      "id": "tietosuoja_guidelines",
      "name": "TSV Guidelines (Ohjeet ja suositukset)",
      "url": "https://tietosuoja.fi/ohjeet-ja-julkaisut",
      "description": "..."
    }
  ],
  "_meta": { ... }
}
```

---

## fi_dp_check_data_freshness

Return current row counts and latest record dates from the database.

**Parameters:** None

**Returns:**
```json
{
  "decisions": { "count": 123, "latest_date": "2025-11-15" },
  "guidelines": { "count": 45, "latest_date": "2025-10-01" },
  "checked_at": "2026-04-09T12:00:00.000Z",
  "_meta": { ... }
}
```

---

## Shared Response Fields

### `_meta` block

Every tool response includes a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "This data is provided for informational purposes only...",
    "copyright": "Tietosuojavaltuutetun toimisto (Finnish Data Protection Ombudsman)...",
    "source_url": "https://tietosuoja.fi/",
    "data_age": "Use fi_dp_check_data_freshness to retrieve current row counts and latest record dates."
  }
}
```

### `_citation` block

`fi_dp_get_decision` and `fi_dp_get_guideline` also include a `_citation` block for the platform entity linker:

```json
{
  "_citation": {
    "canonical_ref": "TSV/2021/4949",
    "display_text": "TSV päätös TSV/2021/4949",
    "source_url": "https://tietosuoja.fi/...",
    "lookup": {
      "tool": "fi_dp_get_decision",
      "args": { "reference": "TSV/2021/4949" }
    }
  }
}
```

---

## Type Definitions

### Decision

```typescript
interface Decision {
  id: number;
  reference: string;
  title: string;
  date: string | null;
  type: string | null;        // seuraamusmaksu | paatos | huomautus | lausunto
  entity_name: string | null;
  fine_amount: number | null;
  summary: string | null;
  full_text: string;
  topics: string | null;      // JSON array of topic IDs
  gdpr_articles: string | null;
  status: string;             // default: 'final'
}
```

### Guideline

```typescript
interface Guideline {
  id: number;
  reference: string | null;
  title: string;
  date: string | null;
  type: string | null;        // ohje | suositus | kannanotto | FAQ
  summary: string | null;
  full_text: string;
  topics: string | null;      // JSON array of topic IDs
  language: string;           // default: 'fi'
}
```

### Topic

```typescript
interface Topic {
  id: string;
  name_local: string;
  name_en: string;
  description: string | null;
}
```
