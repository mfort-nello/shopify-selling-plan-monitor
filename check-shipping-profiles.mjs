// Daily check: alerts if any product that is published to the online store has
// variants sitting on the DEFAULT ("General") delivery profile instead of the
// DTC shipping profile.
//
// Why this matters: the default profile carries a flat $0.00 domestic rate with
// no cart-value condition, so anything that lands there ships free at any order
// value instead of $5.99-under-$50 / free-at-$50. Products drift onto it two ways:
//   1. New landing-page duplicate products are created on the default profile.
//   2. A new flavor variant is added to existing PDPs and only that variant lands
//      on the default profile (the 2026-08-19 CLM-PCR-20 case).
// 83 products were reassigned on 2026-07-16 and 14 products + 1 flavor had drifted
// back by 2026-08-26, so this is recurring, not a one-off.
//
// Products NOT published to the online store (publishedAt === null) are ignored on
// purpose: those are the TikTok Shop / Amazon / Flip marketplace listings, where the
// channel governs shipping and the default profile is harmless.
//
// Required env vars (same secrets as check-selling-plans.mjs):
//   SHOPIFY_STORE          e.g. "tryvitalize.myshopify.com"
//   SHOPIFY_CLIENT_ID      from the Dev Dashboard app
//   SHOPIFY_CLIENT_SECRET  from the Dev Dashboard app
//   SLACK_WEBHOOK_URL      Slack incoming webhook URL
// Optional:
//   DTC_PROFILE_NAME       target profile name (default "DTC Shipping_12.17.2025")
//   SHIPPING_ALLOWLIST     extra comma-separated numeric product IDs to ignore

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DTC_PROFILE_NAME = process.env.DTC_PROFILE_NAME || "DTC Shipping_12.17.2025";
const SHOPIFY_API_VERSION = "2025-10";

// Known-intentional residents of the default profile that are published but
// deliberately not on the DTC ladder. Both are UNLISTED with $0 revenue over the
// 90 days to 2026-08-26. Remove an entry if it should start being enforced.
const ALLOWLIST = new Set([
  "9411331162360",  // Superfocus Multi-Month Subs (UNLISTED; covered by Recharge profile)
  "10225307025656", // Energy (UNLISTED placeholder, sku null)
  ...(process.env.SHIPPING_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

function requireEnv() {
  const missing = [
    ["SHOPIFY_STORE", SHOPIFY_STORE],
    ["SHOPIFY_CLIENT_ID", SHOPIFY_CLIENT_ID],
    ["SHOPIFY_CLIENT_SECRET", SHOPIFY_CLIENT_SECRET],
    ["SLACK_WEBHOOK_URL", SLACK_WEBHOOK_URL],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

let accessToken = null;

async function getAccessToken() {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`OAuth token request failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  }
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`OAuth response missing access_token: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shopify throttles hard on paginated profileItems walks; retry on 429 and on
// THROTTLED GraphQL errors rather than dying mid-walk with a partial picture.
async function shopify(query, variables = {}, attempt = 1) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (res.status === 429 && attempt <= 6) {
    await sleep(1000 * 2 ** (attempt - 1));
    return shopify(query, variables, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const json = await res.json();
  if (json.errors) {
    const throttled = json.errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt <= 6) {
      await sleep(1000 * 2 ** (attempt - 1));
      return shopify(query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const PROFILES_QUERY = `
  query Profiles {
    deliveryProfiles(first: 25) {
      nodes {
        id
        name
        default
        profileLocationGroups {
          locationGroupZones(first: 25) {
            nodes {
              zone { name }
              methodDefinitions(first: 20) {
                nodes {
                  name
                  active
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { price { amount } }
                  }
                  methodConditions { field operator }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// NOTE: do NOT use products(query: "delivery_profile_id:...") for this. That filter
// reads a search index that lags reassignments by minutes-to-hours and will happily
// report products you just moved, producing false alerts. profileItems is live.
const PROFILE_ITEMS_QUERY = `
  query ProfileItems($id: ID!, $cursor: String) {
    deliveryProfile(id: $id) {
      profileItems(first: 100, after: $cursor) {
        nodes {
          product {
            id
            title
            status
            publishedAt
            isGiftCard
            variantsCount { count }
          }
          variants(first: 100) {
            nodes { id sku inventoryItem { requiresShipping } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

async function walkProfileItems(profileId) {
  const items = [];
  let cursor = null;
  do {
    const data = await shopify(PROFILE_ITEMS_QUERY, { id: profileId, cursor });
    const conn = data.deliveryProfile?.profileItems;
    if (!conn) throw new Error(`Profile ${profileId} returned no profileItems`);
    items.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

// A $0.00 rate with no cart-value condition on the default profile is what turns a
// harmless misfile into uncollected shipping revenue. Surface it in the alert footer
// so the root cause stays visible instead of being rediscovered every few months.
export function findFreeUnconditionalRates(profile) {
  const hits = [];
  for (const group of profile.profileLocationGroups || []) {
    for (const zoneNode of group.locationGroupZones?.nodes || []) {
      for (const md of zoneNode.methodDefinitions?.nodes || []) {
        const isFree =
          md.rateProvider?.__typename === "DeliveryRateDefinition" &&
          Number(md.rateProvider.price?.amount) === 0;
        if (md.active && isFree && (md.methodConditions || []).length === 0) {
          hits.push(`${zoneNode.zone.name} / "${md.name}"`);
        }
      }
    }
  }
  return hits;
}

function numericId(gid) {
  return gid.split("/").pop();
}

function adminUrl(gid) {
  return `https://admin.shopify.com/store/${SHOPIFY_STORE.replace(
    ".myshopify.com",
    ""
  )}/products/${numericId(gid)}`;
}

export function buildFindings(defaultItems, dtcSkus, dtcProductIds) {
  const findings = [];
  for (const item of defaultItems) {
    const p = item.product;
    if (!p) continue;
    if (!p.publishedAt) continue;                      // marketplace-only listing
    if (p.status === "ARCHIVED" || p.status === "DRAFT") continue;
    if (p.isGiftCard) continue;                        // gift cards never ship
    if (ALLOWLIST.has(numericId(p.id))) continue;

    // A delivery profile only governs things that actually ship. Without this,
    // the gift cards and the Recipe Book PDFs (all requiresShipping:false, all
    // published, all long-term residents of the default profile) would alert every
    // single day and train everyone to ignore the channel.
    const shippable = (item.variants?.nodes || []).filter(
      (v) => v.inventoryItem?.requiresShipping !== false
    );
    if (shippable.length === 0) continue;

    findings.push({
      id: p.id,
      title: p.title,
      status: p.status,
      onDefaultCount: shippable.length,
      totalCount: p.variantsCount?.count ?? shippable.length,
      // Exact, not inferred: if the product ALSO has variants on the DTC profile
      // then it was moved once and a variant was added later and missed (the
      // CLM-PCR-20 signature). If it appears nowhere on DTC, the whole product was
      // created on the wrong profile.
      kind: dtcProductIds.has(p.id) ? "stray" : "whole",
      skus: shippable
        .map((v) => v.sku)
        .filter(Boolean)
        .map((sku) => (dtcSkus.has(sku) ? `${sku}*` : sku)),
    });
  }
  // Strays first: a live SKU shipping free next to siblings that don't is the
  // sharper miss, and it is the easiest to overlook in the admin.
  findings.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "stray" ? -1 : 1));
  return findings;
}

async function postToSlack(findings, freeRateHits) {
  const MAX_LISTED = 25;
  const shown = findings.slice(0, MAX_LISTED);
  const overflow = findings.length - shown.length;

  const lines = shown.map((f) => {
    const scope =
      f.kind === "stray"
        ? `${f.onDefaultCount} of ${f.totalCount} variants left behind`
        : `all ${f.onDefaultCount} shippable variants`;
    const skus = f.skus.length ? `  \`${f.skus.slice(0, 8).join(", ")}\`` : "";
    const tag = f.kind === "stray" ? ":warning: stray" : "new product";
    return `• <${adminUrl(f.id)}|${f.title}> — ${tag}, ${scope} — \`${f.status}\`${skus}`;
  });
  if (overflow > 0) lines.push(`…and ${overflow} more`);

  const strays = findings.filter((f) => f.kind === "stray").length;
  const wholes = findings.length - strays;

  const contextLines = [
    `Store: \`${SHOPIFY_STORE}\` • Target profile: \`${DTC_PROFILE_NAME}\` • Checked: ${new Date().toISOString()}`,
    "`*` after a SKU = that SKU already exists on the DTC profile elsewhere, so this is a missed variant, not a new SKU.",
  ];
  if (freeRateHits.length) {
    contextLines.push(
      `Root cause still live: default profile has an unconditional $0.00 rate on ${freeRateHits.join(
        ", "
      )} — anything that lands there ships free at any cart value.`
    );
  }

  const payload = {
    text: `🚚 ${findings.length} storefront product${
      findings.length === 1 ? "" : "s"
    } on the default shipping profile (${strays} stray, ${wholes} whole) on ${SHOPIFY_STORE}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🚚 Shipping profile drift detected" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${findings.length}* product${findings.length === 1 ? "" : "s"} published to the online store ` +
            `${findings.length === 1 ? "has variants" : "have variants"} on the *default (General) profile* ` +
            `instead of *${DTC_PROFILE_NAME}* — so ${findings.length === 1 ? "it ships" : "they ship"} ` +
            `free at any cart value instead of $5.99 under $50.`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      {
        type: "context",
        elements: contextLines.map((text) => ({ type: "mrkdwn", text })),
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

async function main() {
  requireEnv();
  console.log(`Fetching access token for ${SHOPIFY_STORE}…`);
  accessToken = await getAccessToken();

  const { deliveryProfiles } = await shopify(PROFILES_QUERY);
  const profiles = deliveryProfiles.nodes;

  const defaultProfile = profiles.find((p) => p.default);
  if (!defaultProfile) throw new Error("No default delivery profile found");

  const dtcProfile = profiles.find((p) => p.name === DTC_PROFILE_NAME);
  if (!dtcProfile) {
    throw new Error(
      `No profile named "${DTC_PROFILE_NAME}". Found: ${profiles
        .map((p) => p.name)
        .join(" | ")}. Set DTC_PROFILE_NAME if it was renamed.`
    );
  }

  console.log(`Default profile: ${defaultProfile.name} (${defaultProfile.id})`);
  console.log(`Target profile:  ${dtcProfile.name} (${dtcProfile.id})`);

  const [defaultItems, dtcItems] = await Promise.all([
    walkProfileItems(defaultProfile.id),
    walkProfileItems(dtcProfile.id),
  ]);
  console.log(
    `Default profile holds ${defaultItems.length} products; target holds ${dtcItems.length}.`
  );

  const dtcSkus = new Set(
    dtcItems.flatMap((i) => (i.variants?.nodes || []).map((v) => v.sku).filter(Boolean))
  );
  const dtcProductIds = new Set(dtcItems.map((i) => i.product?.id).filter(Boolean));

  const findings = buildFindings(defaultItems, dtcSkus, dtcProductIds);
  const freeRateHits = findFreeUnconditionalRates(defaultProfile);

  if (findings.length === 0) {
    console.log("✅ All clear — no storefront products on the default shipping profile.");
    if (freeRateHits.length) {
      console.log(
        `   (FYI: default profile still has an unconditional $0.00 rate on ${freeRateHits.join(", ")}.)`
      );
    }
    return;
  }

  console.error(`❌ ${findings.length} product(s) on the default profile:`);
  for (const f of findings) {
    console.error(
      `  - [${f.kind}] ${f.title} — ${f.onDefaultCount}/${f.totalCount} variants [${f.status}] ${f.skus.join(", ")}`
    );
  }

  await postToSlack(findings, freeRateHits);
  console.log("Posted alert to Slack.");
  // Run stays green: the Slack message is the signal, not the GitHub status.
}

// Only run when invoked directly, so tests can import the pure logic above.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
