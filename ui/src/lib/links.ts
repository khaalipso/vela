// Links of a space: classification of a URL (mirror of `classify` in crates/vela-core/src/links.rs,
// used for the live preview and by the mock backend), grouping for the sheet, chips for the top bar.

import type { Link, LinkKind, LinkSource, Provider } from "./types";

export interface Classified {
  kind: LinkKind;
  provider: Provider;
  key: string | null;
  title: string;
}

interface Parsed {
  host: string;
  seg: string[];
}

function parseUrl(url: string): Parsed | null {
  const m = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m) return null;
  const host = (m[1].split("@").pop() ?? "").split(":")[0].toLowerCase();
  if (!host) return null;
  return { host, seg: m[2].split("/").filter(Boolean) };
}

/** True for an http or https URL with a host. */
export function isHttpUrl(url: string): boolean {
  return parseUrl(url) !== null;
}

const isIssueKey = (s: string) => /^[A-Z][A-Z0-9]+-\d+$/.test(s);
const humanize = (s: string) => s.replace(/[-_+]/g, " ").trim();
const hostIs = (h: string, d: string) => h === d || h.endsWith(`.${d}`);

/** Classify a URL by host and path. Pure, no network. */
export function classify(url: string): Classified {
  const p = parseUrl(url);
  const out = (kind: LinkKind, provider: Provider, key: string | null, title: string): Classified => ({
    kind,
    provider,
    key,
    title,
  });
  if (!p) return out("other", "url", null, url.trim());
  const { host: h, seg } = p;
  const at = (name: string) => seg.indexOf(name);

  if (h.endsWith(".atlassian.net")) {
    const i = at("browse");
    if (i >= 0 && isIssueKey(seg[i + 1] ?? "")) return out("issue", "jira", seg[i + 1], seg[i + 1]);
    if (seg[0] === "wiki") {
      const t = seg[at("pages") + 2];
      return out("doc", "confluence", null, (t && humanize(t)) || "Confluence page");
    }
  }
  if (hostIs(h, "linear.app")) {
    const i = at("issue");
    if (i >= 0 && isIssueKey(seg[i + 1] ?? "")) return out("issue", "linear", seg[i + 1], seg[i + 1]);
  }
  if (hostIs(h, "github.com") && seg.length >= 4 && /^\d+$/.test(seg[3])) {
    const key = `${seg[0]}/${seg[1]}#${seg[3]}`;
    if (seg[2] === "issues") return out("issue", "github", key, key);
    if (seg[2] === "pull") return out("pullRequest", "github", key, key);
  }
  if (hostIs(h, "gitlab.com") || h.startsWith("gitlab.")) {
    for (const [marker, kind, sign] of [
      ["merge_requests", "pullRequest", "!"],
      ["issues", "issue", "#"],
    ] as const) {
      const i = at(marker);
      if (i >= 2 && /^\d+$/.test(seg[i + 1] ?? "")) {
        const key = `${seg.slice(0, i).filter((s) => s !== "-").join("/")}${sign}${seg[i + 1]}`;
        return out(kind, "gitlab", key, key);
      }
    }
  }
  if (hostIs(h, "sentry.io") && at("issues") >= 0 && seg[at("issues") + 1]) {
    const id = seg[at("issues") + 1];
    return out("error", "sentry", id, `Sentry issue ${id}`);
  }
  if (hostIs(h, "figma.com") && ["file", "design", "proto"].includes(seg[0])) {
    return out("design", "figma", null, (seg[2] && humanize(seg[2])) || "Figma file");
  }
  if (hostIs(h, "notion.so") || hostIs(h, "notion.site")) {
    const last = seg[seg.length - 1];
    const title = last
      ? last
          .replace(/-?[0-9a-f]{32}$/i, "")
          .split("-")
          .join(" ")
      : "";
    return out("doc", "notion", null, title || "Notion page");
  }
  if (h === "docs.google.com") {
    const t = seg[0] === "spreadsheets" ? "Google Sheet" : seg[0] === "presentation" ? "Google Slides" : "Google Doc";
    return out("doc", "googleDocs", null, t);
  }
  if (h.includes("grafana")) {
    const t = seg[0] === "d" && seg[2] ? humanize(seg[2]) : "Grafana dashboard";
    return out("dashboard", "grafana", null, t || "Grafana dashboard");
  }
  if (h.startsWith("app.datadoghq.") || hostIs(h, "datadoghq.com") || hostIs(h, "datadoghq.eu")) {
    return out("dashboard", "datadog", null, "Datadog dashboard");
  }
  if (hostIs(h, "slack.com") && at("archives") >= 0) return out("chat", "slack", null, "Slack thread");
  if (h === "localhost" || h === "127.0.0.1") return out("environment", "url", null, "Local");
  if (h.startsWith("staging.")) return out("environment", "url", null, `Staging ${h.slice(8)}`);
  if (h.startsWith("preview.")) return out("environment", "url", null, `Preview ${h.slice(8)}`);
  if (h.endsWith(".vercel.app")) return out("environment", "url", null, `Preview ${h}`);
  const title = seg.length === 0 ? h : seg.length === 1 ? `${h}/${seg[0]}` : `${h}/…/${seg[seg.length - 1]}`;
  return out("other", "url", null, title);
}

/** Stable id of a link: hash of its url, or of its key when there is no url. */
export function linkId(url: string, key?: string | null): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(url ? `url:${url}` : `key:${key ?? ""}`)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `l${h.toString(16).padStart(16, "0")}`;
}

export function makeLink(url: string, title: string | undefined, source: LinkSource): Link {
  const u = url.trim();
  const c = classify(u);
  return {
    id: linkId(u, c.key),
    kind: c.kind,
    provider: c.provider,
    url: u,
    title: title?.trim() || c.title,
    key: c.key,
    source,
    summary: null,
  };
}

/** Same url or same key. */
export function sameLink(a: Link, b: Link): boolean {
  return (!!a.url && a.url === b.url) || (!!a.key && a.key === b.key);
}

/** The links a user can remove: the ones they added themselves. */
export const removable = (l: Link): boolean => l.source === "manual" || l.source === "paste";

// -- presentation -----------------------------------------------------------

export const KIND_ORDER: LinkKind[] = [
  "issue",
  "pullRequest",
  "doc",
  "design",
  "error",
  "dashboard",
  "chat",
  "environment",
  "other",
];

export const KIND_LABEL: Record<LinkKind, string> = {
  issue: "Issues",
  pullRequest: "Pull requests",
  doc: "Docs",
  design: "Designs",
  error: "Errors",
  dashboard: "Dashboards",
  chat: "Chats",
  environment: "Environments",
  other: "Other",
};

export const KIND_SINGULAR: Record<LinkKind, string> = {
  issue: "issue",
  pullRequest: "pull request",
  doc: "doc",
  design: "design",
  error: "error",
  dashboard: "dashboard",
  chat: "chat",
  environment: "environment",
  other: "link",
};

export const SOURCE_LABEL: Record<LinkSource, string> = {
  manual: "added by you",
  paste: "pasted",
  branch: "from the branch",
  commit: "from a commit",
  repo: "from the repo",
  ticket: "ticket of the task",
};

/** Links ordered by kind (the order of the sheet and of J and K); stable inside a kind. */
export function groupLinks(links: Link[]): Link[] {
  return KIND_ORDER.flatMap((k) => links.filter((l) => l.kind === k));
}

export interface Chips {
  shown: Link[];
  /** How many links are not shown. */
  more: number;
}

/** Top bar: up to two issue keys first, then up to three other links. */
export function topBarChips(links: Link[]): Chips {
  const issues = links.filter((l) => l.kind === "issue" && l.key);
  const rest = links.filter((l) => !(l.kind === "issue" && l.key));
  const shown = [...issues.slice(0, 2), ...rest.slice(0, 3)];
  return { shown, more: links.length - shown.length };
}

/** Letter mark and color of a provider, for the small icon before a title. */
export function providerMark(l: Pick<Link, "provider" | "kind">): { text: string; color: string } {
  switch (l.provider) {
    case "jira":
      return { text: "J", color: "#7DB8F5" };
    case "linear":
      return { text: "L", color: "#C9A0F0" };
    case "github":
      return { text: "GH", color: "#9BD0C8" };
    case "gitlab":
      return { text: "GL", color: "#E8A14A" };
    case "sentry":
      return { text: "S", color: "#F0A3C0" };
    case "figma":
      return { text: "F", color: "#F0A3C0" };
    case "notion":
      return { text: "N", color: "#9BD0C8" };
    case "confluence":
      return { text: "C", color: "#7DB8F5" };
    case "googleDocs":
      return { text: "G", color: "#4ADE80" };
    case "grafana":
      return { text: "Gr", color: "#E8A14A" };
    case "datadog":
      return { text: "D", color: "#C9A0F0" };
    case "slack":
      return { text: "Sl", color: "#4ADE80" };
    default:
      return l.kind === "environment" ? { text: "E", color: "#4ADE80" } : { text: "↗", color: "#9BD0C8" };
  }
}

/** Short secondary text of a link: its key, or its host. */
export function linkSub(l: Link): string {
  if (l.key && l.title !== l.key) return l.key;
  if (!l.url) return "";
  try {
    return new URL(l.url).host;
  } catch {
    return "";
  }
}
