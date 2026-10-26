// Example data for the mock backend: the three spaces of ui/reference/prototype.html.

import { makeLink } from "./links";
import type { Agent, Link, Space, StackItem } from "./types";

/** A file the mock holds. `lines` is a snippet that starts at line `firstLine`. */
export interface SeedFile {
  repo: string;
  path: string;
  firstLine: number;
  lines: string[];
}

/** A proposal as the mock stores it: `at` is the line index in the current file content. */
export interface SeedHunk {
  id: string;
  repo: string;
  path: string;
  at: number;
  del: string[];
  add: string[];
  agent: string;
  why: string;
  section?: string;
}

export interface SeedNote {
  hunkId: string;
  by: string;
  text: string;
  fix: string[];
}

export interface SeedQuestion {
  agentId: string;
  text: string;
  yes: string;
  no: string;
}

export interface SeedSpace {
  space: Space;
  files: SeedFile[];
  hunks: SeedHunk[];
  agents: Agent[];
  stack: StackItem[];
  tests: { pass: number; total: number };
  baseStaged: { repo: string; path: string }[];
  commitMsg: string;
  question: SeedQuestion | null;
  notes: SeedNote[];
}

export const REPOS = ["api", "web", "infra", "research-engine", "set.mm", "sillage", "maths"];

const repo = (name: string, worktree: string) => ({ name, source: `~/Work/${name}`, worktree, base: "main" });

const stripe: SeedSpace = {
  space: {
    id: "stripe",
    name: "Stripe v2 billing",
    color: "#E8A14A",
    branch: "feat/stripe-v2",
    repos: [repo("api", "wt/stripe-v2"), repo("web", "wt/stripe-v2"), repo("infra", "main")],
    createdAt: "2026-10-19T09:12:00Z",
    window: null,
  },
  files: [
    {
      repo: "api",
      path: "src/billing/webhook.ts",
      firstLine: 12,
      lines: [
        "export async function handleWebhook(req: Request) {",
        '  const sig = req.headers.get("stripe-signature")',
        "  const event = JSON.parse(await req.text())",
        "  switch (event.type) {",
        '    case "checkout.session.completed":',
        "      await fulfillOrder(event.data.object)",
        "      break",
        '    case "invoice.paid":',
        "      await markInvoicePaid(event.data.object)",
        "      break",
        "  }",
        "  return new Response(null, { status: 200 })",
        "}",
      ],
    },
    {
      repo: "web",
      path: "lib/stripe.ts",
      firstLine: 1,
      lines: [
        'import Stripe from "stripe"',
        "export const stripe = new Stripe(process.env.STRIPE_KEY!, {",
        '  apiVersion: "2024-06-20",',
        "})",
      ],
    },
    {
      repo: "api",
      path: "src/billing/checkout.ts",
      firstLine: 30,
      lines: [
        "export async function createCheckout(cart: Cart) {",
        "  return stripe.checkout.sessions.create({",
        '    mode: "payment",',
        "    line_items: cart.items.map(toLineItem),",
        "  })",
        "}",
      ],
    },
  ],
  hunks: [
    {
      id: "s1",
      repo: "api",
      path: "src/billing/webhook.ts",
      at: 2,
      del: ["  const event = JSON.parse(await req.text())"],
      add: [
        "  const body = await req.text()",
        "  const event = stripe.webhooks.constructEvent(",
        "    body, sig!, env.STRIPE_WEBHOOK_SECRET",
        "  )",
      ],
      agent: "stripe-dev",
      why: "Verify the Stripe signature before trusting the event.",
      section: "handleWebhook(req: Request)",
    },
    {
      id: "s2",
      repo: "web",
      path: "lib/stripe.ts",
      at: 2,
      del: ['  apiVersion: "2024-06-20",'],
      add: ['  apiVersion: "2025-09-30.clover",'],
      agent: "stripe-dev",
      why: "Pin the new API version in one place, used by web and api.",
    },
    {
      id: "s3",
      repo: "api",
      path: "src/billing/webhook.ts",
      at: 3,
      del: [],
      add: ['  log.info("stripe.webhook", { type: event.type, id: event.id })'],
      agent: "stripe-tester",
      why: "Log event ids so the two failing tests can be traced.",
      section: "handleWebhook(req: Request)",
    },
  ],
  agents: [
    {
      id: "stripe-dev",
      space: "stripe",
      role: "developer",
      tool: "claude",
      worktrees: [["api", "wt/stripe-v2-dev"]],
      status: "working",
      summary: "Writing test/webhook.test.ts",
    },
    {
      id: "stripe-reviewer",
      space: "stripe",
      role: "reviewer",
      tool: "codex",
      worktrees: [],
      status: "done",
      summary: "1 blocking note on webhook.ts",
    },
    {
      id: "stripe-tester",
      space: "stripe",
      role: "tester",
      tool: "opencode",
      worktrees: [["api", "wt/stripe-v2-test"]],
      status: "failed",
      summary: "12 of 14 tests pass",
    },
  ],
  stack: [
    { name: "node", version: "22.11", source: "mise.toml", kind: "runtime", state: "ok" },
    { name: "pnpm", version: "9.12", source: "mise.toml", kind: "runtime", state: "ok" },
    { name: "postgres", version: "17", source: "compose.yml", kind: "container", state: "ok", ports: ["5432"] },
    { name: "redis", version: "7", source: "compose.yml", kind: "container", state: "ok", ports: ["6379"] },
    { name: "stripe listen", version: null, source: "tunnel", kind: "runtime", state: "unknown" },
  ],
  tests: { pass: 12, total: 14 },
  baseStaged: [{ repo: "api", path: "src/billing/checkout.ts" }],
  commitMsg:
    "feat(billing): verify Stripe webhook signatures\n\nReject unsigned events with 400 before parsing.\nPin API version in lib/stripe.ts.",
  question: null,
  notes: [
    {
      hunkId: "s1",
      by: "Reviewer · Codex",
      text: "constructEvent throws on a bad signature, so this answers 500 and Stripe retries for 3 days. Catch it and return 400.",
      fix: [
        "  const body = await req.text()",
        "  let event: Stripe.Event",
        "  try {",
        "    event = stripe.webhooks.constructEvent(body, sig!, env.STRIPE_WEBHOOK_SECRET)",
        "  } catch {",
        '    return new Response("bad signature", { status: 400 })',
        "  }",
      ],
    },
  ],
};

const pg: SeedSpace = {
  space: {
    id: "pg",
    name: "Postgres 17",
    color: "#7DB8F5",
    branch: "chore/pg17",
    repos: [repo("api", "wt/pg17"), repo("infra", "wt/pg17")],
    createdAt: "2026-10-21T14:30:00Z",
    window: null,
  },
  files: [
    {
      repo: "infra",
      path: "compose.yml",
      firstLine: 8,
      lines: [
        "services:",
        "  db:",
        "    image: postgres:15-alpine",
        "    environment:",
        "      POSTGRES_DB: app",
        "    volumes:",
        "      - pgdata:/var/lib/postgresql/data",
      ],
    },
    {
      repo: "api",
      path: "migrations/0042_trgm.sql",
      firstLine: 1,
      lines: [
        "-- fuzzy search on customer names",
        "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
        "CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);",
      ],
    },
  ],
  hunks: [
    {
      id: "p1",
      repo: "infra",
      path: "compose.yml",
      at: 2,
      del: ["    image: postgres:15-alpine"],
      add: ["    image: postgres:17-alpine"],
      agent: "pg-dev",
      why: "Bump the base image. Data volume is copied per worktree.",
      section: "services.db",
    },
    {
      id: "p2",
      repo: "infra",
      path: "compose.yml",
      at: 5,
      del: [],
      add: ["    healthcheck:", '      test: ["CMD", "pg_isready", "-U", "app"]', "      interval: 5s"],
      agent: "pg-dev",
      why: "Let api wait for the db instead of crashing on boot.",
      section: "services.db",
    },
  ],
  agents: [
    {
      id: "pg-dev",
      space: "pg",
      role: "developer",
      tool: "crush",
      worktrees: [["api", "wt/pg17-dev"]],
      status: "waiting",
      summary: "Waiting for your answer",
    },
    {
      id: "pg-tester",
      space: "pg",
      role: "tester",
      tool: "claude",
      worktrees: [["api", "wt/pg17-test"]],
      status: "working",
      summary: "Replaying 41 migrations on a copy of prod schema",
    },
  ],
  stack: [
    { name: "node", version: "22.11", source: "mise.toml", kind: "runtime", state: "ok" },
    { name: "postgres", version: "17", source: "compose.yml", kind: "container", state: "starting", ports: ["5433"] },
    { name: "postgres", version: "15", source: "compose.yml", kind: "container", state: "stopped", ports: ["5432"] },
  ],
  tests: { pass: 88, total: 88 },
  baseStaged: [],
  commitMsg: "chore(db): move to Postgres 17\n\nAdd a healthcheck so dependent services wait for the db.",
  question: {
    agentId: "pg-dev",
    text: "pg_trgm is used by the fuzzy index on customers.name. Keep the extension in the new image?",
    yes: "Keep it",
    no: "Drop it and the index",
  },
  notes: [],
};

const mm: SeedSpace = {
  space: {
    id: "mm",
    name: "Metamath verifier",
    color: "#C9A0F0",
    branch: "feat/ac-axiom",
    repos: [repo("research-engine", "wt/ac-axiom"), repo("set.mm", "main · read only")],
    createdAt: "2026-10-23T08:05:00Z",
    window: null,
  },
  files: [
    {
      repo: "research-engine",
      path: "src/verify/frame.rs",
      firstLine: 88,
      lines: [
        "fn check_disjoint(&self, a: Var, b: Var) -> Result<(), VerifyError> {",
        "    if a == b {",
        "        return Err(VerifyError::DisjointSame(a));",
        "    }",
        "    if !self.dv.contains(&(a.min(b), a.max(b))) {",
        "        return Err(VerifyError::MissingDv(a, b));",
        "    }",
        "    Ok(())",
        "}",
      ],
    },
    {
      repo: "research-engine",
      path: "tests/ac.rs",
      firstLine: 1,
      lines: [
        "#[test]",
        "fn ac_frame_rejects_same_var() {",
        '    let db = load("set.mm");',
        '    assert!(db.verify("ac6sg").is_ok());',
        "}",
      ],
    },
  ],
  hunks: [],
  agents: [
    {
      id: "mm-reviewer",
      space: "mm",
      role: "reviewer",
      tool: "claude",
      worktrees: [],
      status: "done",
      summary: "No blocking notes",
    },
    {
      id: "mm-tester",
      space: "mm",
      role: "tester",
      tool: "codex",
      worktrees: [["research-engine", "wt/ac-axiom-test"]],
      status: "done",
      summary: "cargo nextest: 41 of 41",
    },
  ],
  stack: [
    { name: "rust", version: "1.91", source: "rust-toolchain.toml", kind: "runtime", state: "ok" },
    { name: "cargo nextest", version: null, source: "", kind: "runtime", state: "ok" },
  ],
  tests: { pass: 41, total: 41 },
  baseStaged: [
    { repo: "research-engine", path: "src/verify/frame.rs" },
    { repo: "research-engine", path: "tests/ac.rs" },
  ],
  commitMsg: "fix(verify): reject $d with identical variables\n\nAdds tests for the axiom of choice frame.",
  question: null,
  notes: [],
};

export const seedSpaces = (): SeedSpace[] => structuredClone([stripe, pg, mm]);

/** Links each seeded space starts with: what the branch, the repo and the user attached. */
export const seedLinks = (): Record<string, Link[]> => ({
  stripe: [
    makeLink("https://acme.atlassian.net/browse/PAY-412", undefined, "branch"),
    makeLink("https://docs.stripe.com/webhooks", "Stripe webhooks", "manual"),
    makeLink("https://staging.acme.dev/billing", undefined, "manual"),
    makeLink("https://grafana.acme.io/d/pay/payments-latency", "Payments latency", "repo"),
  ].map((l) => (l.url.includes("docs.stripe.com") ? { ...l, kind: "doc" as const } : l)),
  pg: [
    makeLink("https://linear.app/acme/issue/ENG-77/move-to-postgres-17", undefined, "branch"),
    makeLink("https://www.notion.so/acme/Postgres-17-migration-plan-0123456789abcdef0123456789abcdef", undefined, "manual"),
  ],
  mm: [],
});
