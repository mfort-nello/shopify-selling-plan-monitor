// Regression tests for the shipping-profile drift check.
// No network, no credentials: buildFindings is pure, so we feed it fixtures.
//
// The "current" fixture is a real snapshot of the default profile taken
// 2026-08-26 after the 87-variant cleanup, so case 1 pins the all-clear state and
// will fail loudly if the exclusion rules ever start alerting on the gift cards,
// the Recipe Book PDFs, the TikTok listings or the archived duplicates again.
//
// Run: node test-shipping-profiles.mjs

import { buildFindings, findFreeUnconditionalRates } from "./check-shipping-profiles.mjs";

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}\n      expected ${e}\n      actual   ${a}`);
    failures++;
  }
}

const gid = (n) => `gid://shopify/Product/${n}`;
const ships = (sku) => ({ sku, inventoryItem: { requiresShipping: true } });
const noShip = (sku) => ({ sku, inventoryItem: { requiresShipping: false } });

function item(product, variants) {
  return { product, variants: { nodes: variants } };
}

// ---------------------------------------------------------------------------
// 1. Real snapshot of the default profile, post-cleanup. Expect zero findings.
// ---------------------------------------------------------------------------
const CURRENT = [
  // Published but non-shippable — the false-positive class that nearly made this
  // alert useless. Gift cards flagged both by isGiftCard and requiresShipping.
  item(
    { id: gid(8200300298488), title: "Nello Gift Card", status: "ACTIVE", publishedAt: "2023-11-17T20:51:22Z", isGiftCard: true, variantsCount: { count: 6 } },
    [noShip(null), noShip(""), noShip("")]
  ),
  item(
    { id: gid(9267726287096), title: "Recipe Book", status: "ACTIVE", publishedAt: "2025-10-25T16:48:16Z", isGiftCard: false, variantsCount: { count: 1 } },
    [noShip(null)]
  ),
  item(
    { id: gid(9454217003256), title: "Recipe Book - Gift", status: "UNLISTED", publishedAt: "2026-04-13T21:32:54Z", isGiftCard: false, variantsCount: { count: 1 } },
    [noShip(null)]
  ),
  item(
    { id: gid(9475538190584), title: "Nello Gift Card - 10 Gift", status: "UNLISTED", publishedAt: "2026-04-13T21:27:37Z", isGiftCard: true, variantsCount: { count: 1 } },
    [noShip(null)]
  ),
  // Allowlisted: published + UNLISTED + shippable, intentionally left on default.
  item(
    { id: gid(9411331162360), title: "Superfocus Multi-Month Subs", status: "UNLISTED", publishedAt: "2026-02-18T20:30:38Z", isGiftCard: false, variantsCount: { count: 6 } },
    [ships("FCS-FPC2-20"), ships("FCS-FP2-20")]
  ),
  item(
    { id: gid(10225307025656), title: "Energy", status: "UNLISTED", publishedAt: "2026-07-17T20:13:45Z", isGiftCard: false, variantsCount: { count: 1 } },
    [ships(null)]
  ),
  // Marketplace-only listings: publishedAt null. TikTok/Amazon govern shipping.
  item(
    { id: gid(9429495873784), title: "Nello Superbalance … 20 Travel Packets", status: "ACTIVE", publishedAt: null, isGiftCard: false, variantsCount: { count: 4 } },
    [ships("BLN-SL-20"), ships("BLN-BA-20"), ships("BLN-CA-20")]
  ),
  item(
    { id: gid(8121162039544), title: "Nello Supercalm … Travel Packets (20 Servings)", status: "ACTIVE", publishedAt: null, isGiftCard: false, variantsCount: { count: 16 } },
    [ships("CLM-RL-20"), ships("CLM-PCR-20")]
  ),
  item(
    { id: gid(9015559323896), title: "Supercalm (Flip Shop)", status: "ACTIVE", publishedAt: null, isGiftCard: false, variantsCount: { count: 13 } },
    [ships("CLM-RL-20"), ships("CLM-PCR-20")]
  ),
  // Archived / draft duplicates.
  item(
    { id: gid(8290347483384), title: "Nello Supercalm - Tik Tok Shop", status: "ARCHIVED", publishedAt: null, isGiftCard: false, variantsCount: { count: 8 } },
    [ships("TT-SC-STICK-RL-20")]
  ),
  item(
    { id: gid(10273212596472), title: "Nello Variety Pack Bundle", status: "DRAFT", publishedAt: null, isGiftCard: false, variantsCount: { count: 1 } },
    [ships("KIT-CLM-VP6-3-2PK")]
  ),
];

const DTC_SKUS = new Set(["CLM-RL-20", "CLM-PCR-20", "BLN-SL-20", "FCS-FPC2-20", "GLW-SK-20"]);
const DTC_PRODUCT_IDS = new Set([gid(8954267468024), gid(9239427481848)]);

console.log("1. current default-profile snapshot (2026-08-26, post-cleanup)");
check("no findings", buildFindings(CURRENT, DTC_SKUS, DTC_PRODUCT_IDS), []);

// ---------------------------------------------------------------------------
// 2. A brand-new LP duplicate created on the default profile. The 10262*/10281*
//    signature: published, ACTIVE, shippable, absent from the DTC profile.
// ---------------------------------------------------------------------------
const WHOLE = [
  ...CURRENT,
  item(
    { id: gid(10999000111222), title: "Superbalance", status: "ACTIVE", publishedAt: "2026-09-02T00:00:00Z", isGiftCard: false, variantsCount: { count: 3 } },
    [ships("BLN-SL-20"), ships("BLN-CA-20"), ships("BLN-BA-20")]
  ),
];
console.log("2. new LP duplicate on the default profile");
const wholeFound = buildFindings(WHOLE, DTC_SKUS, DTC_PRODUCT_IDS);
check("one finding", wholeFound.length, 1);
check("classified whole", wholeFound[0]?.kind, "whole");
check("counts shippable variants", wholeFound[0]?.onDefaultCount, 3);
check("marks SKU already on DTC", wholeFound[0]?.skus, ["BLN-SL-20*", "BLN-CA-20", "BLN-BA-20"]);

// ---------------------------------------------------------------------------
// 3. The CLM-PCR-20 case: a new flavor added to a PDP whose other variants are
//    already on DTC, so only the new variant is left on the default profile.
// ---------------------------------------------------------------------------
const STRAY = [
  ...CURRENT,
  item(
    { id: gid(8954267468024), title: "Supercalm", status: "ACTIVE", publishedAt: "2025-02-12T20:05:49Z", isGiftCard: false, variantsCount: { count: 31 } },
    [ships("CLM-PCR-20")]
  ),
];
console.log("3. new flavor variant left behind on an already-moved PDP");
const strayFound = buildFindings(STRAY, DTC_SKUS, DTC_PRODUCT_IDS);
check("one finding", strayFound.length, 1);
check("classified stray", strayFound[0]?.kind, "stray");
check("1 of 31 variants", [strayFound[0]?.onDefaultCount, strayFound[0]?.totalCount], [1, 31]);
check("SKU starred as existing on DTC", strayFound[0]?.skus, ["CLM-PCR-20*"]);

// ---------------------------------------------------------------------------
// 4. Strays sort ahead of whole-product misses.
// ---------------------------------------------------------------------------
console.log("4. ordering");
const both = buildFindings([...WHOLE, STRAY[STRAY.length - 1]], DTC_SKUS, DTC_PRODUCT_IDS);
check("stray listed first", both.map((f) => f.kind), ["stray", "whole"]);

// ---------------------------------------------------------------------------
// 5. The root-cause detector: an unconditional $0.00 active rate.
// ---------------------------------------------------------------------------
console.log("5. unconditional free-rate detection on the default profile");
const REAL_DEFAULT_PROFILE = {
  profileLocationGroups: [
    {
      locationGroupZones: {
        nodes: [
          {
            zone: { name: "Domestic" },
            methodDefinitions: {
              nodes: [
                { name: "Standard", active: true, rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "0.0" } }, methodConditions: [] },
                { name: "usps", active: true, rateProvider: { __typename: "DeliveryParticipant" }, methodConditions: [] },
              ],
            },
          },
          {
            zone: { name: "Canada" },
            methodDefinitions: {
              nodes: [
                { name: "dhl_express", active: true, rateProvider: { __typename: "DeliveryParticipant" }, methodConditions: [] },
              ],
            },
          },
        ],
      },
    },
  ],
};
check("finds the $0 Domestic Standard rate", findFreeUnconditionalRates(REAL_DEFAULT_PROFILE), ['Domestic / "Standard"']);

const DTC_LIKE_PROFILE = {
  profileLocationGroups: [
    {
      locationGroupZones: {
        nodes: [
          {
            zone: { name: "Continental US" },
            methodDefinitions: {
              nodes: [
                // Free, but gated at $50 — correct, must NOT be reported.
                { name: "Standard", active: true, rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "0.0" } }, methodConditions: [{ field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO" }] },
                { name: "Standard", active: true, rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "5.99" } }, methodConditions: [{ field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO" }] },
              ],
            },
          },
        ],
      },
    },
  ],
};
check("ignores conditional free shipping", findFreeUnconditionalRates(DTC_LIKE_PROFILE), []);

console.log();
if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("all checks passed");
