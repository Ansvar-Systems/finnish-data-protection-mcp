#!/usr/bin/env tsx
/**
 * Tietosuojavaltuutetun toimisto (Finnish DPA) ingestion crawler.
 *
 * Scrapes tietosuoja.fi and finlex.fi for:
 *   - Decisions (seuraamusmaksut, päätökset) — sanctions, enforcement decisions
 *   - Guidance documents (ohjeet, oppaat, FAQ) — practical data protection guidance
 *
 * Populates the SQLite database used by the MCP server.
 *
 * Data sources:
 *   1. tietosuoja.fi/en/current-issues — English news/press releases about decisions
 *   2. tietosuoja.fi/ajankohtaista     — Finnish news/press releases about decisions
 *   3. tietosuoja.fi/en/organisations  — Structured guidance pages (English)
 *   4. tietosuoja.fi guidance pages     — Finnish guidance content
 *   5. finlex.fi/fi/viranomaiset/tsv/  — Official decision texts (Finnish)
 *
 * Usage:
 *   npx tsx scripts/ingest-tietosuoja.ts                # Full ingestion
 *   npx tsx scripts/ingest-tietosuoja.ts --resume       # Skip already-ingested references
 *   npx tsx scripts/ingest-tietosuoja.ts --dry-run      # Parse and log, do not write to DB
 *   npx tsx scripts/ingest-tietosuoja.ts --force        # Drop existing data and re-ingest
 *
 * Environment:
 *   TSV_DB_PATH      — SQLite database path (default: data/tsv.db)
 *   TSV_USER_AGENT   — Custom User-Agent header (default: built-in)
 *   TSV_RATE_LIMIT   — Milliseconds between requests (default: 1500)
 *   TSV_MAX_RETRIES  — Max retry attempts per request (default: 3)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// cheerio — loaded dynamically so the script fails fast with a clear message
// ---------------------------------------------------------------------------

let cheerio: typeof import("cheerio");
try {
  cheerio = await import("cheerio");
} catch {
  console.error(
    "Missing dependency: cheerio\n" +
      "Install it with:  npm install --save-dev cheerio @types/cheerio\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["TSV_DB_PATH"] ?? "data/tsv.db";
const USER_AGENT =
  process.env["TSV_USER_AGENT"] ??
  "AnsvarTSVCrawler/1.0 (+https://ansvar.eu; data-protection-research)";
const RATE_LIMIT_MS = parseInt(
  process.env["TSV_RATE_LIMIT"] ?? "1500",
  10,
);
const MAX_RETRIES = parseInt(
  process.env["TSV_MAX_RETRIES"] ?? "3",
  10,
);

const BASE_TSV = "https://tietosuoja.fi";
const BASE_FINLEX = "https://finlex.fi";

// CLI flags
const args = new Set(process.argv.slice(2));
const FLAG_RESUME = args.has("--resume");
const FLAG_DRY_RUN = args.has("--dry-run");
const FLAG_FORCE = args.has("--force");

// ---------------------------------------------------------------------------
// Known decision URLs — curated index of sanctions and enforcement decisions
//
// tietosuoja.fi publishes decision announcements as news articles under
// /en/-/<slug> (English) and /-/<slug> (Finnish). Individual article pages
// are accessible via standard HTTP fetch. The Liferay portlet listing pages
// use dynamic pagination with portlet instance IDs; we attempt to crawl
// them, falling back to this curated index if listing pages change.
//
// Finlex hosts official decision texts at
// /fi/viranomaiset/tietosuojavaltuutettu/<year>/<number>
// but uses a Next.js SPA with server-side rendering — individual decision
// pages are not reliably fetchable via plain HTTP. We crawl what we can
// and fall back to the tietosuoja.fi press release content.
// ---------------------------------------------------------------------------

/** Decision source entry — URL + optional pre-known metadata. */
interface DecisionSource {
  url: string;
  /** Stable reference ID (e.g. "TSV-POSTI-OMAPOSTI-2024"). Generated from slug if absent. */
  reference?: string;
  /** Decision type hint — overridden by page content if available. */
  type?: "seuraamusmaksu" | "paatos" | "huomautus" | "kieltomääräys" | "maaräys";
  /** Language of the source page. */
  lang?: "fi" | "en";
}

/** Guidance source entry. */
interface GuidelineSource {
  url: string;
  reference?: string;
  type?: "ohje" | "opas" | "usein_kysyttyä" | "suositus" | "lausunto" | "linjaus";
  lang?: "fi" | "en";
}

// -- Curated decision URLs (sanctions, enforcement, administrative fines) ---

const KNOWN_DECISIONS: DecisionSource[] = [
  // English press releases — sanctions and administrative fines
  {
    url: "/en/-/administrative-fine-imposed-on-posti-for-data-protection-shortcomings-in-the-omaposti-service",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/office-of-the-data-protection-ombudsman-s-sanctions-board-imposed-three-administrative-fines-for-data-protection-violations",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/office-of-the-data-protection-ombudsman-s-sanctions-board-imposes-administrative-fine-for-several-deficiencies-in-personal-data-processing",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/administrative-fine-on-otavamedia-for-deficiencies-in-the-implementation-of-data-protection-rights",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/financial-sanction-on-a-company-due-to-carrying-out-electronic-direct-marketing-without-prior-consent-as-well-as-neglecting-the-rights-of-the-data-subject",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/administrative-fine-imposed-on-company-for-data-protection-violations-connected-to-parking-control-fees",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/administrative-fine-imposed-on-company-for-processing-health-information-without-the-appropriate-consent",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/loan-comparison-provider-sambla-group-issued-administrative-fine-for-data-security-neglect-company-must-notify-customers-of-incident",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/administrative-fine-imposed-on-collection-agency-for-serious-data-protection-violations-company-did-not-respond-to-private-citizens-requests-to-access-their-data",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/administrative-fine-imposed-on-business-directory-operator-for-infringements-of-the-right-to-obtain-call-recordings",
    type: "seuraamusmaksu",
    lang: "en",
  },
  {
    url: "/en/-/the-supreme-administrative-court-maintained-the-decision-of-the-administrative-court-repealing-the-administrative-fine-imposed-on-the-finnish-motor-insurers-centre",
    type: "paatos",
    lang: "en",
  },
  {
    url: "/en/-/administrative-court-office-of-the-data-protection-ombudsman-s-hearing-procedure-and-administrative-fine-imposed-for-gdpr-violation-were-appropriate",
    type: "paatos",
    lang: "en",
  },
  {
    url: "/en/-/finnish-dpa-bans-yango-taxi-service-transfers-of-personal-data-from-finland-to-russia-temporarily",
    type: "kieltomääräys",
    lang: "en",
  },
  {
    url: "/en/-/yliopiston-apteekki-fined-for-online-shop-data-protection-shortcomings",
    type: "seuraamusmaksu",
    lang: "en",
  },
  // Finnish press releases — additional decisions not available in English
  {
    url: "/-/hallinto-oikeus-piti-voimassa-suomen-yritysrekisterille-maaratyn-seuraamusmaksun-tietosuojarikkomuksista",
    type: "paatos",
    lang: "fi",
  },
];

// -- Curated guidance URLs — structured guidance content from tietosuoja.fi --

const KNOWN_GUIDELINES: GuidelineSource[] = [
  // English guidance pages — organisation-facing
  { url: "/en/processing-of-personal-data", type: "ohje", lang: "en" },
  { url: "/en/when-is-the-processing-of-personal-data-permitted", type: "ohje", lang: "en" },
  { url: "/en/consent-of-the-data-subject", type: "ohje", lang: "en" },
  { url: "/en/controller-s-legitimate-interests", type: "ohje", lang: "en" },
  { url: "/en/processing-of-special-categories-of-personal-data", type: "ohje", lang: "en" },
  { url: "/en/impact-assessments", type: "ohje", lang: "en" },
  { url: "/en/carrying-out-an-impact-assessment", type: "ohje", lang: "en" },
  { url: "/en/list-of-processing-operations-which-require-dpia", type: "ohje", lang: "en" },
  { url: "/en/prior-consultation", type: "ohje", lang: "en" },
  { url: "/en/automated-decision-making-and-profiling", type: "ohje", lang: "en" },
  { url: "/en/data-protection-principles", type: "ohje", lang: "en" },
  { url: "/en/lawfulness-fairness-and-transparency", type: "ohje", lang: "en" },
  { url: "/en/purpose-limitation", type: "ohje", lang: "en" },
  { url: "/en/minimisation-of-data", type: "ohje", lang: "en" },
  { url: "/en/accuracy-of-data", type: "ohje", lang: "en" },
  { url: "/en/storage-limitation", type: "ohje", lang: "en" },
  { url: "/en/confidentiality-and-security", type: "ohje", lang: "en" },
  { url: "/en/accountability", type: "ohje", lang: "en" },
  { url: "/en/controller-s-record-of-processing-activities", type: "ohje", lang: "en" },
  { url: "/en/processor-s-record-of-processing-activities", type: "ohje", lang: "en" },
  { url: "/en/inform-data-subjects-about-processing", type: "ohje", lang: "en" },
  { url: "/en/rights-of-the-data-subject", type: "ohje", lang: "en" },
  { url: "/en/right-of-access", type: "ohje", lang: "en" },
  { url: "/en/right-to-rectification", type: "ohje", lang: "en" },
  { url: "/en/right-to-erasure", type: "ohje", lang: "en" },
  { url: "/en/right-to-restriction-of-processing", type: "ohje", lang: "en" },
  { url: "/en/right-to-data-portability", type: "ohje", lang: "en" },
  { url: "/en/right-to-object", type: "ohje", lang: "en" },
  { url: "/en/right-not-to-be-subject-to-a-decision-based-solely-on-automated-processing", type: "ohje", lang: "en" },
  { url: "/en/what-rights-do-data-subjects-have-in-different-situations", type: "ohje", lang: "en" },
  { url: "/en/derogating-from-the-rights-of-data-subjects", type: "ohje", lang: "en" },
  { url: "/en/designating-a-data-protection-officer", type: "ohje", lang: "en" },
  { url: "/en/processors-responsibilities", type: "ohje", lang: "en" },
  { url: "/en/personal-data-breaches", type: "ohje", lang: "en" },
  { url: "/en/data-breach-notification", type: "ohje", lang: "en" },
  { url: "/en/transfers-of-personal-data-out-of-the-eea", type: "ohje", lang: "en" },
  { url: "/en/transfers-on-the-basis-of-an-adequacy-decision", type: "ohje", lang: "en" },
  { url: "/en/standard-clauses-adopted-by-the-commission", type: "ohje", lang: "en" },
  { url: "/en/safeguards-to-supplement-transfer-tools", type: "ohje", lang: "en" },
  { url: "/en/binding-corporate-rules", type: "ohje", lang: "en" },
  { url: "/en/derogations-for-specific-situations", type: "ohje", lang: "en" },
  { url: "/en/codes-of-conduct", type: "ohje", lang: "en" },
  { url: "/en/children-s-data-protection", type: "ohje", lang: "en" },
  { url: "/en/ai-systems-and-data-protection", type: "ohje", lang: "en" },
  { url: "/en/what-is-personal-data", type: "ohje", lang: "en" },
  { url: "/en/pseudonymised-and-anonymised-data", type: "ohje", lang: "en" },
  { url: "/en/legislation", type: "ohje", lang: "en" },
  // FAQ pages — frequently asked questions by topic
  { url: "/en/faq-camera-surveillance", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-direct-marketing", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-health-care", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-working-life", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-dpos", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-banking", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-internet", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-scientific-research", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-credit-information", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-elections", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-personal-identity-code", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-phone-calls", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-search-engines", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-information-systems", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/faq-mobile-location", type: "usein_kysyttyä", lang: "en" },
  { url: "/en/digital-services-act-dsa-", type: "ohje", lang: "en" },
  { url: "/en/scientific-research-and-data-protection", type: "ohje", lang: "en" },
  // EU digital regulation
  { url: "/en/digital-services-act", type: "ohje", lang: "en" },
  { url: "/en/data-act", type: "ohje", lang: "en" },
  // Private persons guidance
  { url: "/en/know-your-rights", type: "ohje", lang: "en" },
  { url: "/en/notification-to-the-data-protection-ombudsman", type: "ohje", lang: "en" },
  { url: "/en/claiming-damages", type: "ohje", lang: "en" },
  // Corrective powers (useful for understanding enforcement)
  { url: "/en/corrective-powers", type: "ohje", lang: "en" },
];

// ---------------------------------------------------------------------------
// Listing page portlet URLs — tietosuoja.fi uses Liferay portlets
//
// The "Ajankohtaista" (Current Issues) listing uses paramYear and paramPage
// for pagination. We crawl multiple years to discover decision announcements.
// ---------------------------------------------------------------------------

const AJANKOHTAISTA_PORTLET_FI = "fi_yja_web_content_listing_portlet_WebContentListingPortlet_INSTANCE_esS7GvYQlntU";
const CURRENT_ISSUES_PORTLET_EN = "fi_yja_web_content_listing_portlet_WebContentListingPortlet_INSTANCE_QbnqYhFoaxk8";

function buildListingUrl(base: string, path: string, portletId: string, year: number, page: number): string {
  const prefix = `_${portletId}_`;
  return (
    `${base}${path}?p_p_id=${portletId}` +
    `&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view` +
    `&${prefix}mvcPath=/jsp/web-content-listing/view.jsp` +
    `&${prefix}paramYear=${year}` +
    `&${prefix}paramPage=${page}`
  );
}

// Years to crawl for decision discovery
const LISTING_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

// ---------------------------------------------------------------------------
// Topic detection — maps Finnish/English keywords to topic IDs
// ---------------------------------------------------------------------------

interface TopicRule {
  id: string;
  name_fi: string;
  name_en: string;
  description: string;
  /** Keywords to match in title + summary + full_text (case-insensitive). */
  keywords: string[];
}

const TOPIC_RULES: TopicRule[] = [
  {
    id: "suostumus",
    name_fi: "Suostumus",
    name_en: "Consent",
    description:
      "Henkilötietojen käsittelyyn tarvittavan suostumuksen kerääminen, pätevyys ja peruuttaminen (GDPR 7 art.).",
    keywords: [
      "suostumus", "consent", "opt-in", "opt-out",
      "hyväksyminen", "peruuttaminen",
    ],
  },
  {
    id: "evästeet",
    name_fi: "Evästeet",
    name_en: "Cookies and trackers",
    description:
      "Evästeiden ja muiden seurantatekniikoiden asettaminen käyttäjän laitteelle.",
    keywords: [
      "eväste", "cookie", "tracking", "seuranta",
      "analytiikka", "analytics", "banneri",
    ],
  },
  {
    id: "siirrot",
    name_fi: "Kansainväliset siirrot",
    name_en: "International transfers",
    description:
      "Henkilötietojen siirtäminen kolmansiin maihin tai kansainvälisille organisaatioille (GDPR 44-49 art.).",
    keywords: [
      "siirto", "transfer", "kolmas maa", "third country",
      "adequacy", "riittävyyspäätös", "schrems",
      "standard contractual", "bcr", "binding corporate",
    ],
  },
  {
    id: "vaikutustenarviointi",
    name_fi: "Tietosuojan vaikutustenarviointi",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description:
      "Korkean riskin käsittelyä koskeva tietosuojan vaikutustenarviointi (GDPR 35 art.).",
    keywords: [
      "vaikutustenarviointi", "impact assessment", "dpia",
      "korkea riski", "high risk",
    ],
  },
  {
    id: "tietoturvaloukkaus",
    name_fi: "Tietoturvaloukkaus",
    name_en: "Data breach notification",
    description:
      "Tietoturvaloukkausten ilmoittaminen tietosuojavaltuutetulle ja rekisteröidyille (GDPR 33-34 art.).",
    keywords: [
      "tietoturvaloukkaus", "data breach", "loukkaus", "breach",
      "ilmoitus", "notification", "72 tuntia", "72 hours",
      "incident",
    ],
  },
  {
    id: "sisäänrakennettu_tietosuoja",
    name_fi: "Sisäänrakennettu tietosuoja",
    name_en: "Privacy by design",
    description:
      "Tietosuojan sisällyttäminen suunnitteluvaiheessa ja oletusarvoisesti (GDPR 25 art.).",
    keywords: [
      "sisäänrakennettu", "privacy by design", "by default",
      "oletusarvoinen", "suunnitteluvaihe",
    ],
  },
  {
    id: "tyontekijöiden_tietosuoja",
    name_fi: "Työntekijöiden tietosuoja",
    name_en: "Employee data protection",
    description:
      "Henkilötietojen käsittely työsuhteessa ja työntekijöiden valvonta.",
    keywords: [
      "työntekijä", "employee", "työsuhde", "employment",
      "valvonta", "monitoring", "sijainti", "location",
      "kuljettaja", "driver", "kameravalvonta työpaikalla",
    ],
  },
  {
    id: "terveydenhuolto",
    name_fi: "Terveystiedot",
    name_en: "Health data",
    description:
      "Terveystietojen käsittely — erityiset henkilötietoryhmät (GDPR 9 art.).",
    keywords: [
      "terveys", "health", "potilas", "patient",
      "sairaala", "hospital", "lääketieteellinen", "medical",
      "apteekki", "pharmacy", "hoitotyö",
    ],
  },
  {
    id: "rekisteröidyn_oikeudet",
    name_fi: "Rekisteröidyn oikeudet",
    name_en: "Data subject rights",
    description:
      "Rekisteröityjen oikeudet, kuten tarkastusoikeus, oikaisupyyntö ja poistamisoikeus (GDPR 12-23 art.).",
    keywords: [
      "rekisteröidyn oikeu", "data subject right", "tarkastusoikeus",
      "right of access", "oikaisupyyntö", "rectification",
      "poistamisoikeus", "erasure", "right to be forgotten",
      "siirto-oikeus", "portability", "vastustamisoikeus", "right to object",
    ],
  },
  {
    id: "lapset",
    name_fi: "Lasten tietosuoja",
    name_en: "Children's data",
    description:
      "Lasten henkilötietojen suoja, erityisesti verkkopalveluissa (GDPR 8 art.).",
    keywords: [
      "lapsi", "child", "children", "alaikäinen", "minor",
      "nuori", "koululainen",
    ],
  },
  {
    id: "kameravalvonta",
    name_fi: "Kameravalvonta",
    name_en: "Camera surveillance",
    description:
      "Kameravalvonta työpaikoilla, julkisilla paikoilla ja asuinalueilla.",
    keywords: [
      "kameravalvonta", "camera surveillance", "videovalvonta",
      "tallentava kamera", "valvontakamera",
    ],
  },
  {
    id: "suoramarkkinointi",
    name_fi: "Suoramarkkinointi",
    name_en: "Direct marketing",
    description:
      "Sähköinen suoramarkkinointi ja henkilötietojen käsittely markkinointitarkoituksiin.",
    keywords: [
      "suoramarkkinointi", "direct marketing", "markkinointi",
      "marketing", "sähköposti", "email", "tekstiviesti", "sms",
    ],
  },
  {
    id: "tietoturva",
    name_fi: "Tietoturva",
    name_en: "Data security",
    description:
      "Tekniset ja organisatoriset toimenpiteet henkilötietojen suojaamiseksi (GDPR 32 art.).",
    keywords: [
      "tietoturva", "data security", "salaus", "encryption",
      "suojatoimenpiteet", "safeguard", "salasana", "password",
      "pääsynhallinta", "access control",
    ],
  },
  {
    id: "profilointi",
    name_fi: "Profilointi ja automaattinen päätöksenteko",
    name_en: "Profiling and automated decision-making",
    description:
      "Automaattinen päätöksenteko ja profilointi (GDPR 22 art.).",
    keywords: [
      "profilointi", "profiling", "automaattinen päätöksenteko",
      "automated decision", "algoritmi", "algorithm", "tekoäly", "ai",
    ],
  },
  {
    id: "tietosuojavastaava",
    name_fi: "Tietosuojavastaava",
    name_en: "Data Protection Officer",
    description:
      "Tietosuojavastaavan nimittäminen, asema ja tehtävät (GDPR 37-39 art.).",
    keywords: [
      "tietosuojavastaava", "data protection officer", "dpo",
    ],
  },
];

// ---------------------------------------------------------------------------
// GDPR article detection — extracts article numbers from Finnish/English text
// ---------------------------------------------------------------------------

const GDPR_ARTICLE_PATTERNS = [
  // Finnish: "5 artikla", "artiklan 32", "33 artiklan"
  /(\d+)\s*(?:artikla|art\.|artiklaa)/gi,
  // Finnish: "tietosuoja-asetuksen 5, 6 ja 13 artikla"
  /(?:tietosuoja-asetuksen|GDPR:n)\s+([\d,\s]+(?:ja\s+\d+)?)\s*art/gi,
  // English: "Article 5", "Art. 32", "Articles 33 and 34"
  /\bArt(?:icle|\.)\s*(\d+(?:\s*(?:and|,\s*\d+))*)/gi,
  // Parenthetical: "(GDPR 33-34 art.)", "(art. 5 GDPR)"
  /\((?:GDPR|tietosuoja-asetus)\s*(\d+(?:\s*[-–,]\s*\d+)*)\s*art/gi,
  /\(art\.\s*(\d+(?:\s*[-–,]\s*\d+)*)\s*(?:GDPR|tietosuoja-asetus)\)/gi,
];

function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  for (const pattern of GDPR_ARTICLE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const numStr = match[1];
      if (!numStr) continue;

      // Split compound references: "5, 6 ja 13" or "33-34" or "5 and 6"
      const nums = numStr.split(/[,\s]+(?:ja|and|[-–])\s*|[,\s]+/).map((s) => s.trim()).filter(Boolean);
      for (const n of nums) {
        const parsed = parseInt(n, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 99) {
          articles.add(String(parsed));
        }
      }
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// ---------------------------------------------------------------------------
// Topic detection
// ---------------------------------------------------------------------------

function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const rule of TOPIC_RULES) {
    const hit = rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (hit) {
      matched.push(rule.id);
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Fine amount extraction — Finnish amounts use space as thousands separator
// ---------------------------------------------------------------------------

const FINE_PATTERNS = [
  // "72 000 euron", "100 000 euroa", "2,4 miljoonan euron"
  /(\d{1,3}(?:\s\d{3})*)\s*euro/gi,
  // "2,4 miljoonaa euroa", "2.4 million euros"
  /(\d+[,.]?\d*)\s*milj(?:oonaa?|ion)\s*euro/gi,
  // "EUR 72,000", "EUR 100,000"
  /EUR\s*(\d{1,3}(?:,\d{3})*)/gi,
  // "€ 72 000", "€72.000"
  /\u20ac\s*(\d{1,3}(?:[\s.]\d{3})*)/gi,
];

function extractFineAmount(text: string): number | null {
  let maxFine = 0;

  for (let i = 0; i < FINE_PATTERNS.length; i++) {
    const pattern = FINE_PATTERNS[i]!;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const rawNum = match[1];
      if (!rawNum) continue;

      let amount: number;

      // Handle "miljoona" (million) pattern
      if (i === 1) {
        const normalized = rawNum.replace(",", ".");
        amount = Math.round(parseFloat(normalized) * 1_000_000);
      } else {
        // Parse Finnish-format "72 000" or EU "72.000" or English "72,000"
        const normalized = rawNum.replace(/[\s.,]/g, "");
        amount = parseInt(normalized, 10);
      }

      if (!isNaN(amount) && amount > maxFine) {
        maxFine = amount;
      }
    }
  }

  return maxFine > 0 ? maxFine : null;
}

// ---------------------------------------------------------------------------
// Date extraction — Finnish date formats
// ---------------------------------------------------------------------------

const FINNISH_MONTHS: Record<string, string> = {
  tammikuuta: "01", tammikuu: "01",
  helmikuuta: "02", helmikuu: "02",
  maaliskuuta: "03", maaliskuu: "03",
  huhtikuuta: "04", huhtikuu: "04",
  toukokuuta: "05", toukokuu: "05",
  kesäkuuta: "06", kesäkuu: "06",
  heinäkuuta: "07", heinäkuu: "07",
  elokuuta: "08", elokuu: "08",
  syyskuuta: "09", syyskuu: "09",
  lokakuuta: "10", lokakuu: "10",
  marraskuuta: "11", marraskuu: "11",
  joulukuuta: "12", joulukuu: "12",
};

const ENGLISH_MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function extractDate(text: string): string | null {
  // Finnish: "14. maaliskuuta 2022", "14.3.2022", "14.03.2022"
  const fiMonthMatch = text.match(
    /(\d{1,2})\.\s*(tammikuuta|helmikuuta|maaliskuuta|huhtikuuta|toukokuuta|kesäkuuta|heinäkuuta|elokuuta|syyskuuta|lokakuuta|marraskuuta|joulukuuta)\s+(\d{4})/i,
  );
  if (fiMonthMatch) {
    const day = (fiMonthMatch[1] ?? "").padStart(2, "0");
    const month = FINNISH_MONTHS[(fiMonthMatch[2] ?? "").toLowerCase()];
    const year = fiMonthMatch[3];
    if (month && year) {
      return `${year}-${month}-${day}`;
    }
  }

  // Finnish numeric: "14.3.2022" or "14.03.2022"
  const fiNumMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (fiNumMatch) {
    const day = (fiNumMatch[1] ?? "").padStart(2, "0");
    const month = (fiNumMatch[2] ?? "").padStart(2, "0");
    const year = fiNumMatch[3];
    if (year) {
      return `${year}-${month}-${day}`;
    }
  }

  // English: "14 March 2022", "September 13, 2023"
  const enMatch = text.match(
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  );
  if (enMatch) {
    const day = (enMatch[1] ?? "").padStart(2, "0");
    const month = ENGLISH_MONTHS[(enMatch[2] ?? "").toLowerCase()];
    const year = enMatch[3];
    if (month && year) {
      return `${year}-${month}-${day}`;
    }
  }

  // English alternative: "March 14, 2022"
  const enAltMatch = text.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (enAltMatch) {
    const month = ENGLISH_MONTHS[(enAltMatch[1] ?? "").toLowerCase()];
    const day = (enAltMatch[2] ?? "").padStart(2, "0");
    const year = enAltMatch[3];
    if (month && year) {
      return `${year}-${month}-${day}`;
    }
  }

  // ISO date: "2023-09-13"
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1] ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entity name extraction from title
// ---------------------------------------------------------------------------

function extractEntityFromTitle(title: string): string | null {
  // Finnish patterns:
  // "Seuraamusmaksu — Taksi Helsinki Oy — EUR 72 000"
  // "Päätös — Posti Group Oyj — tietoturvaloukkaus"
  // "Seuraamusmaksu Sambla Group Oy:lle"
  const dashPattern = title.match(
    /(?:Seuraamusmaksu|Päätös|Hallinnollinen\s+sakko|Huomautus|Administrative\s+fine)\s*[-—–]\s*(.+?)(?:\s*[-—–]|$)/i,
  );
  if (dashPattern && dashPattern[1]) {
    return dashPattern[1].trim();
  }

  // English patterns:
  // "Administrative fine imposed on Posti for ..."
  // "Administrative fine on Otavamedia for ..."
  const enImposedPattern = title.match(
    /(?:fine|sanction|penalty)\s+(?:imposed\s+)?on\s+(.+?)(?:\s+for\s+|\s+due\s+to\s+|\s*$)/i,
  );
  if (enImposedPattern && enImposedPattern[1]) {
    return enImposedPattern[1].trim();
  }

  // "Loan comparison provider Sambla Group issued administrative fine"
  const providerPattern = title.match(
    /(?:provider|company|operator|agency)\s+(.+?)\s+(?:issued|fined|imposed)/i,
  );
  if (providerPattern && providerPattern[1]) {
    return providerPattern[1].trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Decision type inference from title/slug
// ---------------------------------------------------------------------------

function inferDecisionType(title: string, slug: string): string {
  const lower = (title + " " + slug).toLowerCase();
  if (lower.includes("seuraamusmaksu") || lower.includes("administrative fine") || lower.includes("fine")) {
    return "seuraamusmaksu";
  }
  if (lower.includes("kieltomääräys") || lower.includes("ban")) {
    return "kieltomääräys";
  }
  if (lower.includes("huomautus") || lower.includes("reprimand") || lower.includes("warning")) {
    return "huomautus";
  }
  if (lower.includes("määräys") || lower.includes("order")) {
    return "maaräys";
  }
  return "paatos";
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry, rate limiting, and proper headers
// ---------------------------------------------------------------------------

let lastFetchTime = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url: string): Promise<Response | null> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastFetchTime = Date.now();
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fi-FI,fi;q=0.9,en;q=0.5",
        },
        redirect: "follow",
      });

      if (res.ok) {
        return res;
      }

      // 429 Too Many Requests — back off
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        console.warn(`  Rate limited (429), waiting ${retryAfter}s before retry ${attempt}/${MAX_RETRIES}`);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 403 Forbidden — skip after 1 attempt
      if (res.status === 403) {
        console.warn(`  Blocked (403): ${url}`);
        return null;
      }

      // 404 Not Found
      if (res.status === 404) {
        console.warn(`  Not found (404): ${url}`);
        return null;
      }

      // Server errors — retry with backoff
      if (res.status >= 500) {
        console.warn(`  Server error (${res.status}), retry ${attempt}/${MAX_RETRIES}: ${url}`);
        await sleep(2000 * attempt);
        continue;
      }

      // Unexpected status
      console.warn(`  HTTP ${res.status} for ${url}`);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Network error (attempt ${attempt}/${MAX_RETRIES}): ${msg}`);
      if (attempt < MAX_RETRIES) {
        await sleep(2000 * attempt);
      }
    }
  }

  console.error(`  Failed after ${MAX_RETRIES} retries: ${url}`);
  return null;
}

// ---------------------------------------------------------------------------
// HTML page parsing — tietosuoja.fi (Liferay CMS)
// ---------------------------------------------------------------------------

interface ParsedPage {
  title: string;
  date: string | null;
  bodyText: string;
  summaryText: string | null;
}

/**
 * Parse an individual tietosuoja.fi page (article or guidance).
 *
 * tietosuoja.fi runs on Liferay and uses these structures:
 *   - Article pages: <h1 class="...">Title</h1> + body in portlet content areas
 *   - Guidance pages: structured content within .portlet-body or .journal-content
 *   - Date in <time datetime="..."> or schema.org metadata
 */
function parseTsvPage(html: string, sourceUrl: string): ParsedPage | null {
  const $ = cheerio.load(html);

  // -- Title --
  let title =
    $("h1.portlet-title").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("title").text().replace(/\s*\|\s*(?:Data Protection Ombudsman|Tietosuojavaltuutetun toimisto).*$/i, "").trim();

  if (!title) {
    console.warn(`  No title found on ${sourceUrl}`);
    return null;
  }

  // -- Date --
  let date: string | null = null;

  // Try <time datetime="...">
  const timeEl = $("time[datetime]").first();
  if (timeEl.length > 0) {
    date = timeEl.attr("datetime")?.slice(0, 10) ?? null;
  }

  // Meta tag: <meta property="article:published_time">
  if (!date) {
    const metaDate = $('meta[property="article:published_time"]').attr("content");
    if (metaDate) {
      date = metaDate.slice(0, 10);
    }
  }

  // Schema.org datePublished
  if (!date) {
    const schemaDate = $('[itemprop="datePublished"]').attr("content") ??
      $('[itemprop="datePublished"]').text().trim();
    if (schemaDate) {
      date = extractDate(schemaDate);
    }
  }

  // -- Body text --
  // Liferay portal uses .portlet-body, .journal-content-article, or .web-content-article
  let bodyHtml =
    $(".journal-content-article").html() ??
    $(".web-content-article").html() ??
    $(".portlet-body .asset-content").html() ??
    $("article .entry-content").html() ??
    $("article").html() ??
    $("main .portlet-body").html() ??
    $("main").html() ??
    "";

  // Strip nav, header, footer, script, style
  const body$ = cheerio.load(bodyHtml);
  body$("nav, header, footer, script, style, .breadcrumb, .pager, .sidebar, .portlet-topper, .portlet-title-default").remove();

  let bodyText = body$.text().replace(/\s+/g, " ").trim();

  if (!bodyText || bodyText.length < 50) {
    // Fallback: whole page with navigation removed
    const page$ = cheerio.load(html);
    page$("nav, header, footer, script, style, .breadcrumb, .pager, .sidebar, .menu, .portlet-topper").remove();
    bodyText = page$("main").text().replace(/\s+/g, " ").trim();
  }

  if (!bodyText || bodyText.length < 30) {
    console.warn(`  Body text too short (${bodyText.length} chars) on ${sourceUrl}`);
    return null;
  }

  // -- Summary --
  let summaryText: string | null = null;
  const firstParagraph =
    $(".journal-content-article p").first().text().trim() ||
    $(".web-content-article p").first().text().trim() ||
    $("article p").first().text().trim() ||
    $("main p").first().text().trim();
  if (firstParagraph && firstParagraph.length > 30 && firstParagraph.length < 1500) {
    summaryText = firstParagraph;
  }

  // Extract date from body text if not found in metadata
  if (!date) {
    date = extractDate(bodyText);
  }

  return { title, date, bodyText, summaryText };
}

// ---------------------------------------------------------------------------
// Listing page parsing — discover article URLs from portlet listings
// ---------------------------------------------------------------------------

function parseListingPage(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];

  // tietosuoja.fi lists articles as links within the portlet body
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Article links follow the pattern /-/<slug> or /en/-/<slug>
    if (href.match(/^\/(?:en\/)?-\/.+/) && !href.includes("#")) {
      if (!urls.includes(href)) {
        urls.push(href);
      }
    }
  });

  return urls;
}

/**
 * Parse listing page to get total count and check for more pages.
 * Liferay shows "Näytetään 1 - 12 / 24" or "Showing 1 - 12 / 24".
 */
function parseListingTotal(html: string): { shown: number; total: number } | null {
  const $ = cheerio.load(html);
  const text = $.text();

  // Match "Näytetään 1 - 12 / 24" or "Showing 1 - 12 / 24"
  const match = text.match(/(?:Näytetään|Showing)\s+\d+\s*-\s*(\d+)\s*\/\s*(\d+)/);
  if (match) {
    const shown = parseInt(match[1] ?? "0", 10);
    const total = parseInt(match[2] ?? "0", 10);
    return { shown, total };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reference generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable reference from a URL slug.
 * "/en/-/administrative-fine-imposed-on-posti" → "TSV-ADMINISTRATIVE-FINE-IMPOSED-ON-POSTI"
 */
function referenceFromSlug(url: string): string {
  const slug = url.split("/").pop() ?? url;
  return `TSV-${slug.toUpperCase().replace(/[^A-Z0-9-]/g, "")}`;
}

/**
 * Generate a reference for guidance pages.
 * "/en/consent-of-the-data-subject" → "TSV-OHJE-CONSENT-OF-THE-DATA-SUBJECT"
 */
function guidelineReferenceFromSlug(url: string): string {
  const slug = url.split("/").pop() ?? url;
  return `TSV-OHJE-${slug.toUpperCase().replace(/[^A-Z0-9-]/g, "")}`;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created data directory: ${dir}`);
  }

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database (--force)`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function getExistingReferences(db: Database.Database): Set<string> {
  const refs = new Set<string>();
  const rows = db.prepare("SELECT reference FROM decisions").all() as Array<{ reference: string }>;
  for (const row of rows) {
    refs.add(row.reference);
  }
  return refs;
}

function getExistingGuidelineRefs(db: Database.Database): Set<string> {
  const refs = new Set<string>();
  const rows = db
    .prepare("SELECT reference FROM guidelines WHERE reference IS NOT NULL")
    .all() as Array<{ reference: string }>;
  for (const row of rows) {
    refs.add(row.reference);
  }
  return refs;
}

function ensureTopics(db: Database.Database): void {
  const insertTopic = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const insertAll = db.transaction(() => {
    for (const rule of TOPIC_RULES) {
      insertTopic.run(rule.id, rule.name_fi, rule.name_en, rule.description);
    }
  });

  insertAll();
}

// ---------------------------------------------------------------------------
// Ingestion logic
// ---------------------------------------------------------------------------

interface ParsedDecision {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string | null;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
  source_url: string;
}

interface ParsedGuideline {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string | null;
  full_text: string;
  topics: string;
  language: string;
  source_url: string;
}

interface IngestStats {
  decisionsIngested: number;
  decisionsSkipped: number;
  decisionsFailed: number;
  guidelinesIngested: number;
  guidelinesSkipped: number;
  guidelinesFailed: number;
  discoveredUrls: number;
}

async function ingestDecision(
  db: Database.Database,
  source: DecisionSource,
  existingRefs: Set<string>,
  stats: IngestStats,
): Promise<void> {
  const reference = source.reference ?? referenceFromSlug(source.url);

  if (FLAG_RESUME && existingRefs.has(reference)) {
    console.log(`  [skip] ${reference} (already in DB)`);
    stats.decisionsSkipped++;
    return;
  }

  const fullUrl = `${BASE_TSV}${source.url}`;
  console.log(`  Fetching: ${fullUrl}`);

  const res = await rateLimitedFetch(fullUrl);
  if (!res) {
    stats.decisionsFailed++;
    return;
  }

  const html = await res.text();
  const parsed = parseTsvPage(html, source.url);
  if (!parsed) {
    stats.decisionsFailed++;
    return;
  }

  const { title, date, bodyText, summaryText } = parsed;
  const type = source.type ?? inferDecisionType(title, source.url);
  const entityName = extractEntityFromTitle(title);
  const fineAmount = extractFineAmount(bodyText);
  const combinedText = `${title} ${summaryText ?? ""} ${bodyText}`;
  const topics = detectTopics(combinedText);
  const gdprArticles = extractGdprArticles(combinedText);
  const language = source.lang ?? (source.url.includes("/en/") ? "en" : "fi");

  const decision: ParsedDecision = {
    reference,
    title,
    date,
    type,
    entity_name: entityName,
    fine_amount: fineAmount,
    summary: summaryText,
    full_text: bodyText,
    topics: JSON.stringify(topics),
    gdpr_articles: JSON.stringify(gdprArticles),
    status: "final",
    source_url: fullUrl,
  };

  if (FLAG_DRY_RUN) {
    console.log(`  [dry-run] Would insert decision: ${reference}`);
    console.log(`    Title:    ${title}`);
    console.log(`    Date:     ${date ?? "unknown"}`);
    console.log(`    Entity:   ${entityName ?? "unknown"}`);
    console.log(`    Fine:     ${fineAmount != null ? `EUR ${fineAmount.toLocaleString("fi-FI")}` : "N/A"}`);
    console.log(`    Type:     ${type}`);
    console.log(`    Language: ${language}`);
    console.log(`    Topics:   ${topics.join(", ") || "none detected"}`);
    console.log(`    GDPR art: ${gdprArticles.join(", ") || "none detected"}`);
    console.log(`    Body:     ${bodyText.length} chars`);
    stats.decisionsIngested++;
    return;
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO decisions
        (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.reference,
      decision.title,
      decision.date,
      decision.type,
      decision.entity_name,
      decision.fine_amount,
      decision.summary,
      decision.full_text,
      decision.topics,
      decision.gdpr_articles,
      decision.status,
    );
    console.log(`  [ok] Inserted decision: ${reference}`);
    stats.decisionsIngested++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [error] Failed to insert ${reference}: ${msg}`);
    stats.decisionsFailed++;
  }
}

async function ingestGuideline(
  db: Database.Database,
  source: GuidelineSource,
  existingRefs: Set<string>,
  stats: IngestStats,
): Promise<void> {
  const reference = source.reference ?? guidelineReferenceFromSlug(source.url);

  if (FLAG_RESUME && existingRefs.has(reference)) {
    console.log(`  [skip] ${reference} (already in DB)`);
    stats.guidelinesSkipped++;
    return;
  }

  const fullUrl = `${BASE_TSV}${source.url}`;
  console.log(`  Fetching: ${fullUrl}`);

  const res = await rateLimitedFetch(fullUrl);
  if (!res) {
    stats.guidelinesFailed++;
    return;
  }

  const html = await res.text();
  const parsed = parseTsvPage(html, source.url);
  if (!parsed) {
    stats.guidelinesFailed++;
    return;
  }

  const { title, date, bodyText, summaryText } = parsed;
  const type = source.type ?? "ohje";
  const topics = detectTopics(`${title} ${summaryText ?? ""} ${bodyText}`);
  const language = source.lang ?? (source.url.includes("/en/") ? "en" : "fi");

  const guideline: ParsedGuideline = {
    reference,
    title,
    date,
    type,
    summary: summaryText,
    full_text: bodyText,
    topics: JSON.stringify(topics),
    language,
    source_url: fullUrl,
  };

  if (FLAG_DRY_RUN) {
    console.log(`  [dry-run] Would insert guideline: ${reference}`);
    console.log(`    Title:    ${title}`);
    console.log(`    Date:     ${date ?? "unknown"}`);
    console.log(`    Type:     ${type}`);
    console.log(`    Language: ${language}`);
    console.log(`    Topics:   ${topics.join(", ") || "none detected"}`);
    console.log(`    Body:     ${bodyText.length} chars`);
    stats.guidelinesIngested++;
    return;
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO guidelines
        (reference, title, date, type, summary, full_text, topics, language)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guideline.reference,
      guideline.title,
      guideline.date,
      guideline.type,
      guideline.summary,
      guideline.full_text,
      guideline.topics,
      guideline.language,
    );
    console.log(`  [ok] Inserted guideline: ${reference}`);
    stats.guidelinesIngested++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [error] Failed to insert guideline ${reference}: ${msg}`);
    stats.guidelinesFailed++;
  }
}

// ---------------------------------------------------------------------------
// Dynamic URL discovery from listing pages
// ---------------------------------------------------------------------------

async function discoverDecisionUrls(): Promise<string[]> {
  const discovered: string[] = [];

  console.log("Crawling tietosuoja.fi listing pages for decision URLs...");

  // Crawl Finnish "Ajankohtaista" listing by year
  for (const year of LISTING_YEARS) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = buildListingUrl(BASE_TSV, "/ajankohtaista", AJANKOHTAISTA_PORTLET_FI, year, page);
      console.log(`  Listing: ajankohtaista ${year} page ${page}`);

      const res = await rateLimitedFetch(url);
      if (!res) {
        hasMore = false;
        continue;
      }

      const html = await res.text();
      const articleUrls = parseListingPage(html);
      const totalInfo = parseListingTotal(html);

      // Filter for likely decision/sanction articles
      for (const articleUrl of articleUrls) {
        const lower = articleUrl.toLowerCase();
        if (
          lower.includes("seuraamusmaksu") ||
          lower.includes("sakko") ||
          lower.includes("hallinto-oikeus") ||
          lower.includes("korkein-hallinto-oikeus") ||
          lower.includes("paatos") ||
          lower.includes("fine") ||
          lower.includes("sanction") ||
          lower.includes("penalty") ||
          lower.includes("administrative-fine") ||
          lower.includes("data-protection-violation") ||
          lower.includes("kieltomaaray") ||
          lower.includes("huomautus")
        ) {
          if (!discovered.includes(articleUrl)) {
            discovered.push(articleUrl);
          }
        }
      }

      // Check if there are more pages
      if (totalInfo && totalInfo.shown < totalInfo.total) {
        page++;
      } else {
        hasMore = false;
      }
    }
  }

  // Also crawl English "Current Issues" listing
  for (const year of LISTING_YEARS) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = buildListingUrl(BASE_TSV, "/en/current-issues", CURRENT_ISSUES_PORTLET_EN, year, page);
      console.log(`  Listing: current-issues ${year} page ${page}`);

      const res = await rateLimitedFetch(url);
      if (!res) {
        hasMore = false;
        continue;
      }

      const html = await res.text();
      const articleUrls = parseListingPage(html);
      const totalInfo = parseListingTotal(html);

      for (const articleUrl of articleUrls) {
        const lower = articleUrl.toLowerCase();
        if (
          lower.includes("fine") ||
          lower.includes("sanction") ||
          lower.includes("penalty") ||
          lower.includes("administrative") ||
          lower.includes("violation") ||
          lower.includes("ban") ||
          lower.includes("reprimand")
        ) {
          if (!discovered.includes(articleUrl)) {
            discovered.push(articleUrl);
          }
        }
      }

      if (totalInfo && totalInfo.shown < totalInfo.total) {
        page++;
      } else {
        hasMore = false;
      }
    }
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Tietosuojavaltuutetun toimisto (Finnish DPA) Ingestion Crawler ===");
  console.log();
  console.log(`Database:    ${DB_PATH}`);
  console.log(`Rate limit:  ${RATE_LIMIT_MS}ms between requests`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`Flags:       ${[
    FLAG_RESUME && "--resume",
    FLAG_DRY_RUN && "--dry-run",
    FLAG_FORCE && "--force",
  ].filter(Boolean).join(" ") || "(none)"}`);
  console.log();

  // -- Init database --------------------------------------------------------
  const db = initDb();

  ensureTopics(db);
  console.log(`Ensured ${TOPIC_RULES.length} topics in database`);

  const existingDecisionRefs = getExistingReferences(db);
  const existingGuidelineRefs = getExistingGuidelineRefs(db);

  if (FLAG_RESUME) {
    console.log(`Existing decisions: ${existingDecisionRefs.size}`);
    console.log(`Existing guidelines: ${existingGuidelineRefs.size}`);
  }

  const stats: IngestStats = {
    decisionsIngested: 0,
    decisionsSkipped: 0,
    decisionsFailed: 0,
    guidelinesIngested: 0,
    guidelinesSkipped: 0,
    guidelinesFailed: 0,
    discoveredUrls: 0,
  };

  // -- Phase 1: Discover decision URLs from listing pages -------------------
  console.log();
  console.log("--- Phase 1: URL discovery from listing pages ---");

  const discoveredUrls = await discoverDecisionUrls();
  stats.discoveredUrls = discoveredUrls.length;
  console.log(`Discovered ${discoveredUrls.length} potential decision URLs from listing pages`);

  // Merge discovered URLs with curated index (curated takes precedence)
  const curatedDecisionPaths = new Set(KNOWN_DECISIONS.map((d) => d.url));
  const allDecisionSources: DecisionSource[] = [...KNOWN_DECISIONS];

  for (const url of discoveredUrls) {
    if (!curatedDecisionPaths.has(url)) {
      // Determine language from URL path
      const lang: "fi" | "en" = url.startsWith("/en/") ? "en" : "fi";
      allDecisionSources.push({ url, lang });
    }
  }

  console.log(
    `Total decision sources: ${allDecisionSources.length} ` +
      `(${KNOWN_DECISIONS.length} curated + ${allDecisionSources.length - KNOWN_DECISIONS.length} discovered)`,
  );
  console.log(`Total guideline sources: ${KNOWN_GUIDELINES.length} (curated)`);

  // -- Phase 2: Ingest decisions --------------------------------------------
  console.log();
  console.log("--- Phase 2: Ingesting decisions ---");

  for (let i = 0; i < allDecisionSources.length; i++) {
    const source = allDecisionSources[i]!;
    console.log(`[${i + 1}/${allDecisionSources.length}] Decision: ${source.url}`);
    await ingestDecision(db, source, existingDecisionRefs, stats);
  }

  // -- Phase 3: Ingest guidelines -------------------------------------------
  console.log();
  console.log("--- Phase 3: Ingesting guidelines ---");

  for (let i = 0; i < KNOWN_GUIDELINES.length; i++) {
    const source = KNOWN_GUIDELINES[i]!;
    console.log(`[${i + 1}/${KNOWN_GUIDELINES.length}] Guideline: ${source.url}`);
    await ingestGuideline(db, source, existingGuidelineRefs, stats);
  }

  // -- Summary --------------------------------------------------------------
  console.log();
  console.log("=== Ingestion Complete ===");
  console.log();
  console.log(`Decisions:`);
  console.log(`  Ingested: ${stats.decisionsIngested}`);
  console.log(`  Skipped:  ${stats.decisionsSkipped}`);
  console.log(`  Failed:   ${stats.decisionsFailed}`);
  console.log();
  console.log(`Guidelines:`);
  console.log(`  Ingested: ${stats.guidelinesIngested}`);
  console.log(`  Skipped:  ${stats.guidelinesSkipped}`);
  console.log(`  Failed:   ${stats.guidelinesFailed}`);
  console.log();
  console.log(`Discovered URLs from listing pages: ${stats.discoveredUrls}`);

  const decisionCount = (
    db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
  ).cnt;
  const guidelineCount = (
    db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
  ).cnt;
  const topicCount = (
    db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
  ).cnt;

  console.log();
  console.log(`Database totals:`);
  console.log(`  Topics:     ${topicCount}`);
  console.log(`  Decisions:  ${decisionCount}`);
  console.log(`  Guidelines: ${guidelineCount}`);

  db.close();

  console.log();
  console.log(`Database: ${DB_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
