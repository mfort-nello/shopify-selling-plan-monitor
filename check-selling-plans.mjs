// Daily check: alerts if any Shopify product has the
// "Only sell this product with these purchase options" checkbox enabled
// (i.e. `requiresSellingPlan: true`).
//
// Auth flow: client_credentials grant (Dev Dashboard apps, post-Jan-2026).
// At runtime, exchange client_id + client_secret for a 24-hour access token,
// then use it to call the Admin GraphQL API.
//
// Required env vars:
//   SHOPIFY_STORE          e.g. "your-store.myshopify.com"
//   SHOPIFY_CLIENT_ID      from your Dev Dashboard app
//   SHOPIFY_CLIENT_SECRET  from your Dev Dashboard app
//   SLACK_WEBHOOK_URL      Slack incoming webhook URL

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SHOPIFY_API_VERSION = "2025-10";

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

// Shopify's product search syntax does NOT recognize `requires_selling_plan`
// as a filter — passing it silently returns all products. So we paginate
// every product and filter client-side on the boolean field.
const QUERY = `
  query FindLockedProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      edges {
        node {
          id
          title
          handle
          status
          requiresSellingPlan
          sellingPlanGroups(first: 5) {
            edges { node { name } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

let accessToken = null;

async function getAccessToken() {
  const url = `https://${SHOPIFY_STORE}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `OAuth token request failed: ${res.status} ${errBody.slice(0, 500)}`
    );
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error(
      `OAuth response missing access_token: ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return json.access_token;
}

async function shopify(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function findLockedProducts() {
  const locked = [];
  let cursor = null;
  do {
    const data = await shopify(QUERY, { cursor });
    for (const { node } of data.products.edges) {
      if (!node.requiresSellingPlan) continue; // the actual filter
      locked.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        status: node.status,
        plans: node.sellingPlanGroups.edges.map((e) => e.node.name),
      });
    }
    cursor = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (cursor);
  return locked;
}

function adminUrl(gid) {
  const numericId = gid.split("/").pop();
  return `https://${SHOPIFY_STORE}/admin/products/${numericId}`;
}

async function postToSlack(locked) {
  const MAX_LISTED = 20;
  const shown = locked.slice(0, MAX_LISTED);
  const overflow = locked.length - shown.length;

  const lines = shown.map((p) => {
    const plans = p.plans.length ? `  _plans: ${p.plans.join(", ")}_` : "";
    return `• <${adminUrl(p.id)}|${p.title}> — \`${p.status}\`${plans}`;
  });
  if (overflow > 0) lines.push(`…and ${overflow} more`);

  const summary = `🚨 ${locked.length} product${locked.length === 1 ? "" : "s"} locked to selling plans on ${SHOPIFY_STORE}`;

  const payload = {
    text: summary, // fallback for notifications
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🚨 Selling-plan lockout detected" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${locked.length}* product${locked.length === 1 ? " has" : "s have"} ` +
            `*"Only sell this product with these purchase options"* enabled. ` +
            `Customers can ONLY buy via subscription on ${locked.length === 1 ? "this product" : "these products"}.`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Store: \`${SHOPIFY_STORE}\` • Checked: ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook ${res.status}: ${body.slice(0, 500)}`);
  }
}

async function main() {
  console.log(`Fetching access token for ${SHOPIFY_STORE}…`);
  accessToken = await getAccessToken();

  console.log("Checking for locked products…");
  const locked = await findLockedProducts();

  if (locked.length === 0) {
    console.log("✅ All clear — no products have requiresSellingPlan=true.");
    return;
  }

  console.error(`❌ Found ${locked.length} locked product(s):`);
  for (const p of locked) {
    console.error(`  - ${p.title} (${p.handle}) [${p.status}]`);
  }

  await postToSlack(locked);
  console.log("Posted alert to Slack.");
  // Run stays green: the Slack message is the signal, not the GitHub status.
  // Real errors (OAuth, network, Slack post failure) still throw and exit non-zero
  // via the .catch handler below.
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
