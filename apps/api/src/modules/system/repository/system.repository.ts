import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { articles, carriers, companyCarriers, companyInfo, numberSeries, systemSettings, type Db, type Tx } from "@navet/db";
import type {
  CreateArticleNumberSeriesInput,
  CreateCompanyCarrierInput,
  UpdateCompanyInfoInput,
  UpdateNumberSeriesInput,
} from "@navet/shared";
import { DEFAULT_THEME_KEY } from "../service/theme-settings.js";
import { documentNumberTaken } from "../service/number-series.js";
import { lockThemeForSetting } from "./themes.repository.js";
import { readStorageUsage } from "./storage.js";
import { exportStoredFiles } from "./file-export.js";

// Never selects `logo` (bytea) as part of a normal row — that would put
// binary data in a JSON response. Callers that need the actual bytes use
// getLogo() instead.
const companyInfoPublicColumns = {
  id: companyInfo.id,
  name: companyInfo.name,
  orgNumber: companyInfo.orgNumber,
  address: companyInfo.address,
  postalCode: companyInfo.postalCode,
  city: companyInfo.city,
  // Godsadress (Leveransadress/godsmottagning, 0182).
  deliveryAddress: companyInfo.deliveryAddress,
  deliveryPostalCode: companyInfo.deliveryPostalCode,
  deliveryCity: companyInfo.deliveryCity,
  phone: companyInfo.phone,
  email: companyInfo.email,
  website: companyInfo.website,
  bankgiro: companyInfo.bankgiro,
  plusgiro: companyInfo.plusgiro,
  bankName: companyInfo.bankName,
  iban: companyInfo.iban,
  bic: companyInfo.bic,
  vatNumber: companyInfo.vatNumber,
  companySeat: companyInfo.companySeat,
  fSkatt: companyInfo.fSkatt,
  hasLogo: sql<boolean>`${companyInfo.logo} is not null`,
  updatedAt: companyInfo.updatedAt,
};

// The writes PATCH /settings makes, on its transaction.
function settingsWriter(tx: Tx) {
  return {
    // Ställkostnadsartikel: the setting must name an article that exists,
    // held FOR KEY SHARE until the setting is committed.
    async lockArticle(id: string): Promise<boolean> {
      const rows = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, id)).for("key share");
      return rows.length > 0;
    },

    // Egna teman: Förvalt tema för företaget, written only while the theme
    // exists — false (nothing written) for an unknown id. The theme row is
    // locked against a concurrent delete (lockThemeForSetting).
    async setDefaultTheme(id: string): Promise<boolean> {
      if (!(await lockThemeForSetting(tx, id))) return false;
      await upsertSetting(tx, DEFAULT_THEME_KEY, id);
      return true;
    },

    setSetting(key: string, value: string) {
      return upsertSetting(tx, key, value);
    },
  };
}
export type SettingsWriter = ReturnType<typeof settingsWriter>;

async function upsertSetting(executor: Db | Tx, key: string, value: string) {
  await executor
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

export function createSystemRepository(db: Db) {
  return {
    async storageUsage() {
      return readStorageUsage(db);
    },

    // Exportera filer: every stored file with its folder, bytes read in batches.
    storedFiles() {
      return exportStoredFiles(db);
    },

    // Singleton table — exactly one row, seeded by the migration.
    async getCompanyInfo() {
      const [row] = await db.select(companyInfoPublicColumns).from(companyInfo);
      return row ?? null;
    },

    async updateCompanyInfo(input: UpdateCompanyInfoInput) {
      const [row] = await db
        .update(companyInfo)
        .set({ ...input, updatedAt: new Date() })
        .returning();
      if (!row) return null;
      const { logo: _logo, ...rest } = row;
      return { ...rest, hasLogo: row.logo !== null };
    },

    async getLogo() {
      const [row] = await db.select({ logo: companyInfo.logo, logoContentType: companyInfo.logoContentType }).from(companyInfo);
      return row ?? null;
    },

    async updateLogo(logo: Buffer, contentType: string) {
      await db.update(companyInfo).set({ logo, logoContentType: contentType, updatedAt: new Date() });
    },

    async listNumberSeries() {
      return db.select().from(numberSeries);
    },

    // G1: read before write — updateNumberSeries's audit entry needs the
    // pre-update row to log a before/after diff.
    async getNumberSeries(key: string) {
      const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, key));
      return row ?? null;
    },

    // Nummerserier's PATCH runs in one transaction: the series row locked
    // FOR UPDATE, the guard, the write.
    transaction<T>(fn: (tx: Tx) => Promise<T>) {
      return db.transaction(fn);
    },

    // The same row lock getNextOrderNumber's UPDATE takes: a document
    // allocating from the series waits for the PATCH, and one that allocated
    // before it has committed by the time the guard reads its table.
    async lockNumberSeries(tx: Tx, key: string) {
      const [row] = await tx.select().from(numberSeries).where(eq(numberSeries.key, key)).for("update");
      return row ?? null;
    },

    documentNumberTaken(tx: Tx, key: string, number: string) {
      return documentNumberTaken(tx, key, number);
    },

    async updateNumberSeries(key: string, input: UpdateNumberSeriesInput, executor: Db | Tx = db) {
      const [row] = await executor.update(numberSeries).set(input).where(eq(numberSeries.key, key)).returning();
      return row ?? null;
    },

    // Egna artikelserier: the key is generated by the service, the name is
    // unique (number_series_name_unique).
    async createArticleNumberSeries(key: string, input: CreateArticleNumberSeriesInput) {
      const [row] = await db
        .insert(numberSeries)
        .values({ key, ...input, forArticles: true })
        .returning();
      return row!;
    },

    // Article groups pointing at the series fall back to the default (FK
    // ON DELETE set null); articles keep the numbers they were given.
    async deleteNumberSeries(key: string) {
      const [row] = await db.delete(numberSeries).where(eq(numberSeries.key, key)).returning();
      return row ?? null;
    },

    async getSetting(key: string) {
      const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      return row?.value ?? null;
    },

    // Every system_settings row in ONE select — getSettings() builds its
    // whole typed view off this instead of ~30 separate getSetting() round
    // trips (one per key, via Promise.all).
    async getAllSettings() {
      return db.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings);
    },

    // PATCH /settings: every write in ONE transaction — a refused reference
    // (Förvalt tema, Ställkostnadsartikel) or a failing write leaves nothing
    // half saved, and the händelselogg (written after commit) always matches.
    writeSettings<T>(fn: (writer: SettingsWriter) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(settingsWriter(tx)));
    },

    // --- Company carrier accounts (Företagsinformation → Speditörer) ---

    async listCompanyCarriers() {
      return db
        .select({ ...getTableColumns(companyCarriers), carrierCode: carriers.code, carrierName: carriers.name })
        .from(companyCarriers)
        .innerJoin(carriers, eq(carriers.id, companyCarriers.carrierId))
        .orderBy(asc(carriers.name));
    },

    async getCarrierById(id: string) {
      const [row] = await db.select().from(carriers).where(eq(carriers.id, id));
      return row ?? null;
    },

    // The company's customer number at a carrier — for printing on the PO/RFQ
    // when the company pays the freight. Null when no account is registered.
    async getCompanyCarrierNumber(carrierId: string) {
      const [row] = await db
        .select({ customerNumber: companyCarriers.customerNumber })
        .from(companyCarriers)
        .where(eq(companyCarriers.carrierId, carrierId));
      return row?.customerNumber ?? null;
    },

    async createCompanyCarrier(input: CreateCompanyCarrierInput) {
      const [row] = await db.insert(companyCarriers).values(input).returning();
      return row!;
    },

    async findCompanyCarrier(id: string) {
      const [row] = await db.select().from(companyCarriers).where(eq(companyCarriers.id, id));
      return row ?? null;
    },

    async updateCompanyCarrier(id: string, customerNumber: string) {
      const [row] = await db
        .update(companyCarriers)
        .set({ customerNumber })
        .where(eq(companyCarriers.id, id))
        .returning();
      return row ?? null;
    },

    async deleteCompanyCarrier(id: string) {
      const [row] = await db.delete(companyCarriers).where(eq(companyCarriers.id, id)).returning();
      return row ?? null;
    },
  };
}

export type SystemRepository = ReturnType<typeof createSystemRepository>;
