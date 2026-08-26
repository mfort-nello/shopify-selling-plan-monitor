# Shopify Selling-Plan Monitor

Daily check that pings Slack if any product in your Shopify store has the **"Only sell this product with these purchase options"** checkbox enabled (i.e. `requiresSellingPlan: true`). When that checkbox is on, the product is locked to subscriptions only — customers can't buy it as a one-time purchase.

The script runs on GitHub Actions cron once a day. If anything's locked, it posts to Slack with a list of products and direct admin links. If everything's clean, it stays quiet.

## Setup

### 1. Create a Dev Dashboard app

As of January 1, 2026, Shopify retired the legacy "create custom app in admin" flow. New apps are created in the Dev Dashboard and authenticate via OAuth client credentials (no more permanent `shpat_` tokens copy-pasted from a UI).

1. From your Shopify admin: **Settings → Apps and sales channels → Develop apps → Build apps in Dev Dashboard**.
2. Create a new app. For distribution choose **Custom distribution** and target your store.
3. Configure access scopes — only `read_products` is required.
4. Install the app on your store.
5. From the app's **Configuration / Client credentials** page, copy the **Client ID** and **Client secret**. The client secret is only shown once — save it now.

### 2. Create a Slack incoming webhook

Go to <https://api.slack.com/apps> → create an app (or pick an existing one) → **Incoming Webhooks** → enable → **Add New Webhook to Workspace** → pick the channel you want alerts in. Copy the webhook URL.

### 3. Push this folder to a GitHub repo

```bash
cd shopify-selling-plan-monitor
git init
git add .
git commit -m "initial"
git remote add origin <your-repo-url>
git push -u origin main
```

### 4. Add four repo secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add each:

| Name                    | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `SHOPIFY_STORE`         | `your-store.myshopify.com` (no `https://`, no trailing `/`) |
| `SHOPIFY_CLIENT_ID`     | Client ID from the Dev Dashboard app                        |
| `SHOPIFY_CLIENT_SECRET` | Client secret from the Dev Dashboard app                    |
| `SLACK_WEBHOOK_URL`     | The webhook URL from step 2                                 |

### 5. Test it

Go to **Actions → Daily Shopify config checks → Run workflow**. If it's green, you're done. If you have a locked product right now, you'll get a Slack message immediately and the run will be red.

It runs automatically every day at 14:00 UTC after that. Edit the cron line in `.github/workflows/daily-check.yml` to change the time.

## Local run

```bash
export SHOPIFY_STORE=your-store.myshopify.com
export SHOPIFY_CLIENT_ID=your_client_id
export SHOPIFY_CLIENT_SECRET=your_client_secret
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
npm run check
```

## How it works

1. The script POSTs to `https://{store}/admin/oauth/access_token` with `grant_type=client_credentials` to exchange the client ID + secret for a 24-hour Admin API access token.
2. It paginates every product via the Admin GraphQL API and filters client-side on the `requiresSellingPlan` boolean. (Shopify's product search syntax doesn't recognize `requires_selling_plan` as a filter — it silently ignores it and returns all products — so server-side filtering isn't an option.)
3. For each match it sends a Slack Block Kit message with admin links and exits non-zero so the GitHub Actions run also turns red.

The script fetches a fresh token on every run, so there's nothing to refresh or cache between runs.

## Notes

- The script alerts on locked products in **any** status — `ACTIVE`, `DRAFT`, and `ARCHIVED`. If you only care about live products, tighten the loop in `findLockedProducts()` with `if (node.status !== "ACTIVE") continue;`.
- The Slack message lists up to 20 products and shows `…and N more` if there are extras. Bump `MAX_LISTED` in the script to change.
- Shopify API version is pinned to `2025-10`. Update `SHOPIFY_API_VERSION` in the script when you want to roll forward.
- If you have a legacy custom app from before Jan 2026 with a permanent `shpat_` token, this script can be trivially adapted — drop the `getAccessToken()` call and set `accessToken` directly from a `SHOPIFY_ACCESS_TOKEN` env var.


---

## Check 2: shipping-profile drift (`check-shipping-profiles.mjs`)

Alerts when a product **published to the online store** has shippable variants sitting on
the default ("General") delivery profile instead of `DTC Shipping_12.17.2025`.

### Why

The default profile carries a flat **$0.00 domestic rate with no cart-value condition**, so
anything that lands there ships free at any order value instead of $5.99-under-$50 /
free-at-$50. Measured on 2026-08-26: sub-$50 storefront orders containing only
default-profile items collected **$0.00** shipping across 168 orders in 30 days, against
**$4.40** average on the DTC-profile control — and 152 of 152 of those orders carried no
discount code, so it was the profile, not a promo.

Two drift mechanisms, both seen live:

| Kind | What happened |
|------|---------------|
| `whole` | A new landing-page duplicate product is created on the default profile. The `10262*` / `10281*` ad dupes, published 2026-08-13 and 08-21. |
| `stray` | A new flavor variant is added to PDPs that were already moved, and only that variant lands on the default profile. `CLM-PCR-20`, first sold 2026-08-19, was left behind on 14 Supercalm PDPs. |

83 products were reassigned on 2026-07-16 and 14 products plus one flavor had drifted back
by 2026-08-26. It recurs, which is why it is a daily check and not a one-off cleanup.

### What it deliberately ignores

- **Products not published to the online store** (`publishedAt === null`) — the TikTok Shop,
  Amazon and Flip listings. Those channels govern their own shipping, so the default profile
  is harmless there. This matters: the single largest default-profile product is the
  Superbalance 20ct listing at ~$1.19M/30d, 100% TikTok.
- **Anything that doesn't ship** — gift cards (`isGiftCard`) and every variant with
  `requiresShipping: false`. Without this the two gift cards and the two Recipe Book PDFs
  alert every day and the channel gets muted.
- **ARCHIVED and DRAFT** products.
- **`ALLOWLIST`** in the script: `9411331162360` (Superfocus Multi-Month Subs) and
  `10225307025656` (Energy) — both UNLISTED with $0 revenue, intentionally left on default.
  Add more via the `SHIPPING_ALLOWLIST` env var (comma-separated numeric IDs) or edit the const.

### Gotcha worth keeping

Do **not** use `products(query: "delivery_profile_id:...")` for this. That filter reads a
search index that lags reassignments by minutes to hours — it happily returned all 30
pre-move products right after the 2026-08-26 fix. `deliveryProfile.profileItems` and
`ProductVariant.deliveryProfile` are live. The check uses `profileItems`.

### Alert-only

It reports; it does not reassign. The "is this a storefront product" test is a heuristic, and
a genuinely TikTok-only new listing should not be auto-moved. The fix is
`deliveryProfileUpdate(id: <dtc profile>, profile: { variantsToAssociate: [...] })` —
associating pulls the variant out of its old profile automatically, no dissociate needed.

### Root cause it also surfaces

Each alert footer names any unconditional active $0.00 rate still live on the default profile.
Putting a real rate there would make future drift cheap instead of expensive — worth doing,
but it is a separate decision because it touches the profile the marketplace listings sit on.

### Tests

`node test-shipping-profiles.mjs` (also `npm test`, and a workflow step). Pure-logic
regression suite over a real snapshot of the default profile taken after the 2026-08-26
cleanup, so it fails loudly if the exclusion rules ever start alerting on the gift cards, the
Recipe Books, the marketplace listings or the archived duplicates again. No network, no secrets.
