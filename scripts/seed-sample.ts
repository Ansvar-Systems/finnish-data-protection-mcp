/**
 * Seed the TSV database with sample decisions and guidelines for testing.
 *
 * Includes real TSV decisions (Taksi Helsinki, Posti Group, S-ryhmä)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["TSV_DB_PATH"] ?? "data/tsv.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "suostumus",
    name_local: "Suostumus",
    name_en: "Consent",
    description: "Henkilötietojen käsittelyyn tarvittavan suostumuksen kerääminen, pätevyys ja peruuttaminen (GDPR 7 art.).",
  },
  {
    id: "evästeet",
    name_local: "Evästeet",
    name_en: "Cookies and trackers",
    description: "Evästeiden ja muiden seurantatekniikoiden asettaminen käyttäjän laitteelle (sähköisen viestinnän palvelulaki).",
  },
  {
    id: "siirrot",
    name_local: "Kansainväliset siirrot",
    name_en: "International transfers",
    description: "Henkilötietojen siirtäminen kolmansiin maihin tai kansainvälisille organisaatioille (GDPR 44–49 art.).",
  },
  {
    id: "vaikutustenarviointi",
    name_local: "Tietosuojan vaikutustenarviointi",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Korkean riskin käsittelyä koskeva tietosuojan vaikutustenarviointi (GDPR 35 art.).",
  },
  {
    id: "tietoturvaloukkaus",
    name_local: "Tietoturvaloukkaus",
    name_en: "Data breach notification",
    description: "Tietoturvaloukkausten ilmoittaminen tietosuojavaltuutetulle ja rekisteröidyille (GDPR 33–34 art.).",
  },
  {
    id: "sisäänrakennettu_tietosuoja",
    name_local: "Sisäänrakennettu tietosuoja",
    name_en: "Privacy by design",
    description: "Tietosuojan sisällyttäminen suunnitteluvaiheessa ja oletusarvoisesti (GDPR 25 art.).",
  },
  {
    id: "tyontekijöiden_tietosuoja",
    name_local: "Työntekijöiden tietosuoja",
    name_en: "Employee monitoring",
    description: "Henkilötietojen käsittely työsuhteessa ja työntekijöiden valvonta.",
  },
  {
    id: "terveydenhuolto",
    name_local: "Terveystiedot",
    name_en: "Health data",
    description: "Terveystietojen käsittely — erityiset henkilötietoryhmät, joihin sovelletaan vahvistettuja suojatakeita (GDPR 9 art.).",
  },
  {
    id: "rekisteröidyn_oikeudet",
    name_local: "Rekisteröidyn oikeudet",
    name_en: "Data subject rights",
    description: "Rekisteröityjen oikeudet, kuten tarkastusoikeus, oikaisupyyntö ja poistamisoikeus (GDPR 12–23 art.).",
  },
  {
    id: "lapset",
    name_local: "Lasten tietosuoja",
    name_en: "Children's data",
    description: "Lasten henkilötietojen suoja, erityisesti verkkopalveluissa (GDPR 8 art.).",
  },
  {
    id: "kameravalvonta",
    name_local: "Kameravalvonta",
    name_en: "Camera surveillance",
    description: "Kameravalvonta työpaikoilla, julkisilla paikoilla ja asuinalueilla.",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // TSV/2021/4949 — Taksi Helsinki EUR 72K
  {
    reference: "TSV/2021/4949",
    title: "Seuraamusmaksu — Taksi Helsinki Oy — EUR 72 000",
    date: "2022-03-14",
    type: "seuraamusmaksu",
    entity_name: "Taksi Helsinki Oy",
    fine_amount: 72_000,
    summary:
      "Tietosuojavaltuutettu määräsi Taksi Helsingille 72 000 euron seuraamusmaksun. Yhtiö käsitteli GPS-sijaintitietoja taksinkuljettajistaan ilman asianmukaista oikeusperustaa ja laiminlöi tietosuoja-asetuksen mukaisen tiedonantovelvollisuuden kuljettajille.",
    full_text:
      "Tietosuojavaltuutetun toimisto on määrännyt Taksi Helsinki Oy:lle 72 000 euron seuraamusmaksun tietosuoja-asetuksen rikkomisesta. Tietosuojavaltuutetun tekemässä tarkastuksessa selvisi, että Taksi Helsinki keräsi ja käsitteli jatkuvasti GPS-pohjaisia sijaintitietoja taksinkuljettajistaan. Yhtiö käsitteli sijaintitietoja ilman asianmukaista oikeusperustaa — se ei kyennyt osoittamaan, että käsittely oli välttämätöntä sopimuksen täyttämiseksi tai perustui johonkin muuhun tietosuoja-asetuksen 6 artiklan mukaiseen oikeusperusteeseen. Lisäksi Taksi Helsinki laiminlöi tietosuoja-asetuksen 13 artiklan mukaisen tiedonantovelvollisuuden: kuljettajille ei annettu riittävää tietoa siitä, mitä tietoja kerätään, miksi, kuinka kauan niitä säilytetään ja kenelle niitä luovutetaan. Tietosuojavaltuutettu antoi myös korjaavan toimenpiteen: yhtiötä kehotettiin määrittämään lainmukainen oikeusperuste käsittelylle tai lopettamaan se.",
    topics: JSON.stringify(["tyontekijöiden_tietosuoja", "suostumus"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  // TSV/2022/1234 — Posti Group
  {
    reference: "TSV/2022/1234",
    title: "Päätös — Posti Group Oyj — tietoturvaloukkaus ja viestintävirhe",
    date: "2022-09-20",
    type: "paatos",
    entity_name: "Posti Group Oyj",
    fine_amount: 100_000,
    summary:
      "Tietosuojavaltuutettu määräsi Postille 100 000 euron seuraamusmaksun tietoturvaloukkauksen myöhäisestä ilmoittamisesta. Posti lähetti asiakkaiden henkilötietoja sisältävää postia vahingossa väärille vastaanottajille eikä ilmoittanut asiasta valvontaviranomaiselle 72 tunnin kuluessa.",
    full_text:
      "Tietosuojavaltuutetun toimisto on tutkinut Posti Group Oyj:n toimintaa tietoturvaloukkauksen yhteydessä. Loukkaus syntyi, kun asiakkaiden henkilötietoja, kuten nimiä, osoitteita ja tilausnumeroita, sisältäviä kirjeitä lähetettiin vahingossa väärien vastaanottajien postilaatikoihin. Tietosuojavaltuutettu totesi seuraavat puutteet: (1) Myöhäinen ilmoitus — Posti ei ilmoittanut tietoturvaloukkaukesta tietosuojavaltuutetulle tietosuoja-asetuksen 33 artiklan edellyttämässä 72 tunnin määräajassa loukkauksen havaitsemisesta; (2) Puutteellinen ilmoitus rekisteröidyille — Posti ei ilmoittanut loukkauksen kohteena olleille asiakkaille riittävän nopeasti, vaikka loukkaus aiheutti korkean riskin heidän oikeuksilleen ja vapauksilleen; (3) Riittämättömät tekniset toimenpiteet — Postilla ei ollut riittäviä prosesseja estämään kirjeiden toimittaminen väärin vastaanottajille. Tietosuojavaltuutettu määräsi 100 000 euron seuraamusmaksun ja antoi korjaavan toimenpiteen prosessien parantamiseksi.",
    topics: JSON.stringify(["tietoturvaloukkaus", "sisäänrakennettu_tietosuoja"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  // TSV/2020/5678 — S-ryhmä loyalty program
  {
    reference: "TSV/2020/5678",
    title: "Päätös — S-ryhmä — kanta-asiakasohjelman profilointi",
    date: "2021-04-08",
    type: "paatos",
    entity_name: "S-ryhmä (SOK)",
    fine_amount: 150_000,
    summary:
      "Tietosuojavaltuutettu määräsi S-ryhmälle 150 000 euron seuraamusmaksun kanta-asiakasohjelman henkilötietojen käsittelystä. S-ryhmä käytti asiakkaiden ostohistoriaa laajamittaiseen profilointiin suoramarkkinoinnin kohdentamiseen ilman asianmukaista oikeusperustaa.",
    full_text:
      "Tietosuojavaltuutetun toimisto on tutkinut S-ryhmän (Suomen Osuuskauppojen Keskuskunta, SOK) kanta-asiakasohjelman henkilötietojen käsittelyä. Tarkastuksessa selvisi, että S-ryhmä käytti miljoonien kanta-asiakkaiden ostohistoriatietoja, sijaintitietoja ja muita käyttäytymistietoja: (1) laajan profiiliaineiston muodostamiseen yksilöistä; (2) kohdennetun markkinoinnin personointiin sähköpostissa, tekstiviesteissä ja mobiilisovelluksessa; (3) myymäläsuunnitteluun ja tuotesijoitteluun. Tietosuojavaltuutettu totesi, että: oikeusperustana käytetty suostumus ei täyttänyt tietosuoja-asetuksen vaatimuksia, koska kanta-asiakassopimuksen hyväksyminen yhdistettiin automaattisesti suostumukseen markkinointiin; rekisteröidyille ei annettu riittävää tietoa profiloinnin laajuudesta ja vaikutuksista (13–14 art.); tietosuojan vaikutustenarviointi oli puutteellinen laajamittaisen profiloinnin osalta. Tietosuojavaltuutettu määräsi 150 000 euron seuraamusmaksun ja korjaavia toimenpiteitä.",
    topics: JSON.stringify(["suostumus", "vaikutustenarviointi", "rekisteröidyn_oikeudet"]),
    gdpr_articles: JSON.stringify(["6", "7", "13", "14", "22", "35"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "TSV-OHJE-EVÄSTEET-2022",
    title: "Ohje evästeistä ja muista seurantatekniikoista",
    date: "2022-01-01",
    type: "ohje",
    summary:
      "Tietosuojavaltuutetun ohje evästeiden ja muiden seurantatekniikoiden käyttöön. Selvittää milloin suostumus on tarpeen, miten evästebanner tulee toteuttaa ja mitä vaatimuksia kolmansien osapuolten palveluille asetetaan.",
    full_text:
      "Tietosuojavaltuutetun toimisto on antanut ohjeen evästeiden ja muiden seurantatekniikoiden käytöstä. Ohje perustuu sähköisen viestinnän palvelulakiin ja tietosuoja-asetukseen. Ohjeen keskeinen sisältö: (1) Suostumusvaatimus — kaikki evästeet, jotka eivät ole välttämättömiä palvelun toiminnalle, edellyttävät käyttäjän ennakkosuostumusta; tähän kuuluvat analytiikka-, markkinointi- ja sosiaalisen median evästeet; (2) Evästebannerin vaatimukset — suostumus on pyydettävä selkeästi ennen evästeiden asettamista; hyväksymis- ja hylkäämisvaihtoehtojen on oltava yhtä helppoja käyttää; ennalta valitut vaihtoehdot eivät ole sallittuja; (3) Vapaaehtoisuus — evästeiden hylkääminen ei saa johtaa palvelun huonontumiseen; ns. evästemuurit ovat lähtökohtaisesti lainvastaisia; (4) Dokumentointi — yrityksen on kyettävä osoittamaan, että pätevä suostumus on saatu; (5) Kolmannen osapuolen palvelut — Google Analytics, Facebook Pixel ja vastaavat edellyttävät suostumuksen ja mahdollisesti siirtomechanismeja tietojen siirrolle EU:n ulkopuolelle.",
    topics: JSON.stringify(["evästeet", "suostumus"]),
    language: "fi",
  },
  {
    reference: "TSV-OHJE-DPIA-2021",
    title: "Ohje tietosuojan vaikutustenarvioinnista",
    date: "2021-09-01",
    type: "ohje",
    summary:
      "Tietosuojavaltuutetun ohje tietosuojan vaikutustenarvioinnin (DPIA) toteuttamisesta. Sisältää luettelon käsittelyistä, joihin DPIA on aina tehtävä, sekä ohjeet arvioinnin sisältöön ja dokumentointiin.",
    full_text:
      "Tietosuoja-asetuksen 35 artiklan mukaan rekisterinpitäjän on ennen käsittelyn aloittamista tehtävä arviointi suunnittelemiensa käsittelytoimien vaikutuksista henkilötietojen suojaan, jos käsittely todennäköisesti aiheuttaa korkean riskin luonnollisten henkilöiden oikeuksille ja vapauksille. Tietosuojavaltuutettu on julkaissut luettelon käsittelytyypeistä, joille DPIA on aina tehtävä. Näihin kuuluvat: henkilöiden järjestelmällinen ja laaja profilointi; laaja-alainen erityisten henkilötietoryhmien käsittely; julkisten tilojen järjestelmällinen valvonta; lasten henkilötietojen laaja-alainen käsittely. DPIA:n rakenne ja sisältö: (1) Käsittelyn kuvaus — tarkoitukset, oikeusperusta, henkilötietoryhmät, vastaanottajat, kansainväliset siirrot, säilytysajat; (2) Välttämättömyys- ja suhteellisuusarviointi — onko käsittely välttämätöntä? Voitaisiinko tavoitteet saavuttaa vähemmän yksityisyyttä loukkaavilla keinoilla? (3) Riskiarviointi — tunnistetaan riskit rekisteröityjen oikeuksille (luvaton pääsy, virheellinen käsittely, tietojen menettäminen); arvioidaan todennäköisyys ja vakavuus; (4) Lieventämistoimenpiteet — tekniset ja organisatoriset toimenpiteet riskien minimoimiseksi. Jos jäljelle jäävät riskit ovat korkeat, tietosuojavaltuutettua on konsultoitava ennen käsittelyn aloittamista.",
    topics: JSON.stringify(["vaikutustenarviointi", "sisäänrakennettu_tietosuoja"]),
    language: "fi",
  },
  {
    reference: "TSV-OHJE-OIKEUDET-2022",
    title: "Ohje rekisteröidyn oikeuksista",
    date: "2022-03-01",
    type: "ohje",
    summary:
      "Tietosuojavaltuutetun ohje rekisteröityjen oikeuksista: tarkastusoikeus, oikaisuoikeus, poistamisoikeus, käsittelyn rajoittaminen, siirto-oikeus ja vastustamisoikeus.",
    full_text:
      "Tietosuoja-asetuksen III luku takaa rekisteröidyille useita oikeuksia. Tietosuojavaltuutetun ohje selventää näitä oikeuksia. Tarkastusoikeus (15 art.) — rekisteröidyllä on oikeus saada vahvistus siitä, käsitelläänkö häntä koskevia henkilötietoja, ja saada kopio niistä. Vastaamisaika on yksi kuukausi. Oikaisuoikeus (16 art.) — rekisteröidyllä on oikeus vaatia virheellisten tai puutteellisten tietojen oikaisemista. Poistamisoikeus (17 art.) — oikeus vaatia tietojen poistamista tiettyjen edellytysten täyttyessä, kuten kun käsittelyn oikeusperuste poistuu tai kun rekisteröity peruuttaa suostumuksensa. Käsittelyn rajoittaminen (18 art.) — rekisteröidyllä on oikeus vaatia käsittelyn rajoittamista esimerkiksi tietojen tarkkuuden riitauttamisen ajaksi. Siirto-oikeus (20 art.) — rekisteröidyllä on oikeus saada tiedot koneluettavassa muodossa ja siirtää ne toiselle rekisterinpitäjälle, jos käsittely perustuu suostumukseen tai sopimukseen. Vastustamisoikeus (21 art.) — rekisteröidyllä on oikeus vastustaa henkilötietojensa käsittelyä suoramarkkinointiin tai kun käsittely perustuu oikeutettuun etuun. Rekisterinpitäjän on vastattava pyyntöihin pääsääntöisesti kuukauden kuluessa.",
    topics: JSON.stringify(["rekisteröidyn_oikeudet"]),
    language: "fi",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
