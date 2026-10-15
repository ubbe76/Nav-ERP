import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articleGroups, db } from "@navet/db";
import { createPostingRuleSchema, postingVatRateSchema, updatePostingRuleSchema } from "@navet/shared";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import {
  AccountNotFoundError,
  ArticleGroupNotFoundError,
  DuplicatePostingRuleError,
  InactiveAccountError,
  PostingRuleNoAccountsError,
  PostingRuleNotFoundError,
  createEconomyService,
} from "../src/modules/economy/service/economy.service.js";

const repo = createEconomyRepository(db);
// audit is unused by every posting-rule CRUD method (no audit trail
// requirement in the brief) — a no-op stub, same idiom as
// economy-accounts.test.ts.
const service = createEconomyService(repo, { log: async () => {} });

// posting_rules has no user-facing FK, so unlike economy-verifications.test.ts
// there is no `users` table to truncate here.
const TRUNCATE = sql`TRUNCATE posting_rules, article_groups, accounts CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticleGroup(code: string, name: string) {
  const [row] = await db.insert(articleGroups).values({ code, name }).returning();
  return row!;
}

async function makeAccount(number: string, name: string) {
  return service.createAccount({ number, name });
}

describe("economy service — posting rules: create", () => {
  it("creates a rule scoped to a VAT rate", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");

    const rule = await service.createPostingRule({
      articleGroupId: group.id,
      vatRate: 25,
      revenueAccountId: revenue.id,
      costAccountId: null,
    });

    expect(rule.articleGroupId).toBe(group.id);
    expect(Number(rule.vatRate)).toBe(25);
    expect(rule.revenueAccountId).toBe(revenue.id);
    expect(rule.costAccountId).toBeNull();
  });

  it("creates a catch-all rule with vatRate null", async () => {
    const group = await makeArticleGroup("320", "Övrigt");
    const cost = await makeAccount("4000", "Inköp material");

    const rule = await service.createPostingRule({
      articleGroupId: group.id,
      vatRate: null,
      revenueAccountId: null,
      costAccountId: cost.id,
    });

    expect(rule.vatRate).toBeNull();
    expect(rule.costAccountId).toBe(cost.id);
    expect(rule.revenueAccountId).toBeNull();
  });

  it("rejects a non-existent article group (404 ArticleGroupNotFoundError)", async () => {
    const revenue = await makeAccount("3001", "Försäljning");

    await expect(
      service.createPostingRule({
        articleGroupId: "00000000-0000-0000-0000-000000000000",
        vatRate: null,
        revenueAccountId: revenue.id,
        costAccountId: null,
      })
    ).rejects.toBeInstanceOf(ArticleGroupNotFoundError);
  });

  it("rejects a non-existent account (404 AccountNotFoundError, not a raw FK violation)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");

    await expect(
      service.createPostingRule({
        articleGroupId: group.id,
        vatRate: null,
        revenueAccountId: "00000000-0000-0000-0000-000000000000",
        costAccountId: null,
      })
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("rejects an inactive account (400 InactiveAccountError)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    await service.updateAccount(revenue.id, { active: false });

    await expect(
      service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: revenue.id, costAccountId: null })
    ).rejects.toBeInstanceOf(InactiveAccountError);
  });

  it("rejects a duplicate (group, vatRate) combination (409)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    const revenue2 = await makeAccount("3002", "Övrig försäljning");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: 25, revenueAccountId: revenue.id, costAccountId: null });

    await expect(
      service.createPostingRule({ articleGroupId: group.id, vatRate: 25, revenueAccountId: revenue2.id, costAccountId: null })
    ).rejects.toBeInstanceOf(DuplicatePostingRuleError);
  });

  it("rejects a duplicate catch-all (group, null) combination (409)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    const revenue2 = await makeAccount("3002", "Övrig försäljning");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: revenue.id, costAccountId: null });

    await expect(
      service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: revenue2.id, costAccountId: null })
    ).rejects.toBeInstanceOf(DuplicatePostingRuleError);
  });
});

describe("economy service — posting rules: list (joined)", () => {
  it("lists rules joined with group code/name and both accounts' number/name, ordered by group code then vatRate NULLS LAST", async () => {
    const groupA = await makeArticleGroup("100", "Grupp A");
    const groupB = await makeArticleGroup("200", "Grupp B");
    const revenue = await makeAccount("3001", "Försäljning");
    const cost = await makeAccount("4000", "Inköp material");

    await service.createPostingRule({ articleGroupId: groupB.id, vatRate: 25, revenueAccountId: revenue.id, costAccountId: null });
    await service.createPostingRule({ articleGroupId: groupB.id, vatRate: null, revenueAccountId: null, costAccountId: cost.id });
    await service.createPostingRule({ articleGroupId: groupA.id, vatRate: 6, revenueAccountId: revenue.id, costAccountId: cost.id });

    const rows = await service.listPostingRules();
    expect(rows).toHaveLength(3);

    // Group A (code "100") sorts before group B (code "200").
    expect(rows[0]?.groupCode).toBe("100");
    expect(rows[0]?.groupName).toBe("Grupp A");
    expect(Number(rows[0]?.vatRate)).toBe(6);
    expect(rows[0]?.revenueAccountNumber).toBe("3001");
    expect(rows[0]?.revenueAccountName).toBe("Försäljning");
    expect(rows[0]?.costAccountNumber).toBe("4000");
    expect(rows[0]?.costAccountName).toBe("Inköp material");

    // Within group B, the rate-specific row (25) sorts before the catch-all
    // (null) — NULLS LAST.
    expect(rows[1]?.groupCode).toBe("200");
    expect(Number(rows[1]?.vatRate)).toBe(25);
    expect(rows[2]?.groupCode).toBe("200");
    expect(rows[2]?.vatRate).toBeNull();
    expect(rows[2]?.revenueAccountNumber).toBeNull();
    expect(rows[2]?.costAccountNumber).toBe("4000");
  });
});

describe("economy service — posting rules: update", () => {
  it("updates the revenue account", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    const revenue2 = await makeAccount("3002", "Övrig försäljning");
    const rule = await service.createPostingRule({ articleGroupId: group.id, vatRate: 25, revenueAccountId: revenue.id, costAccountId: null });

    const updated = await service.updatePostingRule(rule.id, { revenueAccountId: revenue2.id });
    expect(updated.revenueAccountId).toBe(revenue2.id);
  });

  it("rejects changing vatRate to one already taken within the same group (409)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: 25, revenueAccountId: revenue.id, costAccountId: null });
    const rule6 = await service.createPostingRule({ articleGroupId: group.id, vatRate: 6, revenueAccountId: revenue.id, costAccountId: null });

    await expect(service.updatePostingRule(rule6.id, { vatRate: 25 })).rejects.toBeInstanceOf(DuplicatePostingRuleError);
  });

  it("throws PostingRuleNotFoundError for a missing id", async () => {
    await expect(
      service.updatePostingRule("00000000-0000-0000-0000-000000000000", { vatRate: 6 })
    ).rejects.toBeInstanceOf(PostingRuleNotFoundError);
  });

  it("rejects a non-existent article group on update (404)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    const rule = await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: revenue.id, costAccountId: null });

    await expect(
      service.updatePostingRule(rule.id, { articleGroupId: "00000000-0000-0000-0000-000000000000" })
    ).rejects.toBeInstanceOf(ArticleGroupNotFoundError);
  });

  // CARRIED FINDING from Task 1's review (packages/shared/src/economy.ts
  // ~line 150): updatePostingRuleSchema's "at least one account" refine only
  // sees the PATCH payload, not the stored row — {costAccountId: null} alone
  // passes zod because revenueAccountId is untouched (undefined !== null).
  // The service must merge the patch onto the stored row and reject once the
  // MERGED result has both accounts null.
  it("rejects a PATCH that nulls the only account set on the stored row (merged-both-null, 400 PostingRuleNoAccountsError)", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const cost = await makeAccount("4000", "Inköp material");
    const rule = await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: null, costAccountId: cost.id });

    // The patch alone is zod-valid — revenueAccountId is never mentioned, so
    // the schema's own refine can't see that the stored row has it null too.
    expect(updatePostingRuleSchema.safeParse({ costAccountId: null }).success).toBe(true);

    await expect(service.updatePostingRule(rule.id, { costAccountId: null })).rejects.toBeInstanceOf(
      PostingRuleNoAccountsError
    );
  });
});

describe("economy service — posting rules: delete", () => {
  it("deletes a rule", async () => {
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await makeAccount("3001", "Försäljning");
    const rule = await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: revenue.id, costAccountId: null });

    await service.deletePostingRule(rule.id);

    const rows = await service.listPostingRules();
    expect(rows).toHaveLength(0);
  });

  it("throws PostingRuleNotFoundError for a missing id", async () => {
    await expect(service.deletePostingRule("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      PostingRuleNotFoundError
    );
  });
});

describe("postingVatRateSchema — zod avvisar sats 21.5", () => {
  it("rejects a VAT rate that isn't one of 0/6/12/25", () => {
    expect(postingVatRateSchema.safeParse(21.5).success).toBe(false);
    expect(
      createPostingRuleSchema.safeParse({
        articleGroupId: "00000000-0000-0000-0000-000000000000",
        vatRate: 21.5,
        revenueAccountId: "00000000-0000-0000-0000-000000000000",
      }).success
    ).toBe(false);
  });
});
