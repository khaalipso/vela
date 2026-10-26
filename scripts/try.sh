#!/usr/bin/env bash
# Launch Vela on throwaway demo repos. Nothing outside the sandbox is touched.
#   scripts/try.sh            set up the sandbox (once) and launch the app
#   scripts/try.sh --reset    rebuild the sandbox from scratch, then launch
#   scripts/try.sh --setup    set up the sandbox only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${VELA_SANDBOX:-${XDG_CACHE_HOME:-$HOME/.cache}/vela-sandbox}"
export VELA_HOME="$SANDBOX/home"
export VELA_REPO_ROOTS="$SANDBOX/repos"
export XDG_CONFIG_HOME="$SANDBOX/config"

g() { git -C "$1" -c user.name="Demo" -c user.email="demo@example.com" -c commit.gpgsign=false "${@:2}"; }

setup() {
  rm -rf "$SANDBOX"
  mkdir -p "$VELA_REPO_ROOTS" "$XDG_CONFIG_HOME/vela"
  cd "$ROOT" && cargo build -q -p vela-cli
  local vela="$ROOT/target/debug/vela"

  cat > "$XDG_CONFIG_HOME/vela/config.toml" <<'EOF'
[issues]
jira = "https://example.atlassian.net/browse/{key}"
EOF

  # shop-api
  local api="$VELA_REPO_ROOTS/shop-api"
  mkdir -p "$api/src/billing" "$api/test" "$api/.vela"
  cat > "$api/package.json" <<'EOF'
{ "name": "shop-api", "version": "1.0.0" }
EOF
  cat > "$api/src/billing/webhook.ts" <<'EOF'
export async function handleWebhook(req: Request) {
  const sig = req.headers.get("stripe-signature")
  const event = JSON.parse(await req.text())
  switch (event.type) {
    case "checkout.session.completed":
      await fulfillOrder(event.data.object)
      break
    case "invoice.paid":
      await markInvoicePaid(event.data.object)
      break
  }
  return new Response(null, { status: 200 })
}
EOF
  cat > "$api/src/billing/checkout.ts" <<'EOF'
export async function createCheckout(cart: Cart) {
  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: cart.items.map(toLineItem),
  })
}
EOF
  cat > "$api/.vela/links.toml" <<'EOF'
[[links]]
url = "https://grafana.example.com/d/billing/payments"
title = "Payments dashboard"

[[links]]
url = "https://staging.shop.example.com"
title = "Staging"
EOF
  git init -q -b main "$api" && g "$api" add -A && g "$api" commit -qm "feat: billing webhook"
  for i in 1 2 3; do echo "// note $i" >> "$api/src/billing/checkout.ts"; g "$api" commit -qam "chore(billing): tidy checkout $i"; done

  # shop-web
  local web="$VELA_REPO_ROOTS/shop-web"
  mkdir -p "$web/lib"
  cat > "$web/package.json" <<'EOF'
{ "name": "shop-web", "version": "1.0.0" }
EOF
  cat > "$web/lib/stripe.ts" <<'EOF'
import Stripe from "stripe"
export const stripe = new Stripe(process.env.STRIPE_KEY!, {
  apiVersion: "2024-06-20",
})
EOF
  git init -q -b main "$web" && g "$web" add -A && g "$web" commit -qm "feat: stripe client"

  # infra, to pick when creating a new space
  local infra="$VELA_REPO_ROOTS/infra"
  mkdir -p "$infra"
  printf 'services:\n  db:\n    image: postgres:15-alpine\n' > "$infra/compose.yml"
  git init -q -b main "$infra" && g "$infra" add -A && g "$infra" commit -qm "chore: compose"

  # A space already in progress, with changes to review and commit
  "$vela" space new "Stripe webhook signatures" --repo "$api" --repo "$web" >/dev/null
  local wt="$VELA_HOME/worktrees/stripe-webhook-signatures"
  g "$wt/shop-api" commit -q --allow-empty -m "chore: start PAY-412"
  sed -i 's|  const event = JSON.parse(await req.text())|  const body = await req.text()\n  const event = stripe.webhooks.constructEvent(body, sig!, env.STRIPE_WEBHOOK_SECRET)|' "$wt/shop-api/src/billing/webhook.ts"
  sed -i 's|  return new Response(null, { status: 200 })|  log.info("stripe.webhook", { type: event.type, id: event.id })\n  return new Response(null, { status: 200 })|' "$wt/shop-api/src/billing/webhook.ts"
  mkdir -p "$wt/shop-api/test"
  cat > "$wt/shop-api/test/webhook.test.ts" <<'EOF'
test("rejects a bad signature", async () => {
  const res = await handleWebhook(fakeRequest({ sig: "bad" }))
  expect(res.status).toBe(400)
})
EOF
  sed -i 's|2024-06-20|2025-09-30.clover|' "$wt/shop-web/lib/stripe.ts"
  g "$wt/shop-web" add lib/stripe.ts

  echo "Sandbox ready in $SANDBOX"
}

case "${1:-}" in
  --reset) setup ;;
  --setup) setup; exit 0 ;;
  *) [ -d "$VELA_HOME" ] || setup ;;
esac

cd "$ROOT"
[ -d ui/node_modules ] || pnpm -C ui install
pnpm -C ui dev --port 5173 --strictPort >/dev/null 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -sf http://localhost:5173 >/dev/null && break; sleep 0.2; done
cargo run -q -p vela-app
