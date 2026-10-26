import { describe, expect, it } from "vitest";
import { classify, groupLinks, isHttpUrl, linkId, linkSub, makeLink, removable, sameLink, topBarChips } from "./links";
import type { Link } from "./types";

const c = (u: string) => {
  const x = classify(u);
  return [x.kind, x.provider, x.key] as const;
};

describe("classify", () => {
  it("mirrors the core rules for trackers", () => {
    expect(c("https://acme.atlassian.net/browse/PAY-412")).toEqual(["issue", "jira", "PAY-412"]);
    expect(c("https://acme.atlassian.net/browse/PAY-9?focusedCommentId=3")).toEqual(["issue", "jira", "PAY-9"]);
    expect(c("https://linear.app/acme/issue/ENG-77/move-to-postgres-17")).toEqual(["issue", "linear", "ENG-77"]);
    expect(c("https://github.com/acme/api/issues/12")).toEqual(["issue", "github", "acme/api#12"]);
    expect(c("https://github.com/acme/api/pull/34/files")).toEqual(["pullRequest", "github", "acme/api#34"]);
    expect(c("https://gitlab.com/acme/api/-/merge_requests/8")).toEqual(["pullRequest", "gitlab", "acme/api!8"]);
    expect(c("https://acme.sentry.io/issues/45678/?project=1")).toEqual(["error", "sentry", "45678"]);
    expect(c("https://github.com/acme/api")).toEqual(["other", "url", null]);
  });

  it("mirrors the core rules for docs, designs, dashboards and chats", () => {
    expect(classify("https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Billing+design")).toMatchObject({
      kind: "doc",
      provider: "confluence",
      title: "Billing design",
    });
    expect(classify("https://www.figma.com/design/AbC123/Checkout-flow?node-id=1")).toMatchObject({
      kind: "design",
      provider: "figma",
      title: "Checkout flow",
    });
    expect(classify("https://www.notion.so/acme/Billing-migration-0123456789abcdef0123456789abcdef")).toMatchObject({
      kind: "doc",
      provider: "notion",
      title: "Billing migration",
    });
    expect(classify("https://docs.google.com/spreadsheets/d/abc").title).toBe("Google Sheet");
    expect(classify("https://grafana.acme.io/d/abc123/payments-latency")).toMatchObject({
      kind: "dashboard",
      provider: "grafana",
      title: "payments latency",
    });
    expect(c("https://app.datadoghq.com/dashboard/abc")).toEqual(["dashboard", "datadog", null]);
    expect(c("https://acme.slack.com/archives/C012/p1700")).toEqual(["chat", "slack", null]);
  });

  it("environments and the rest", () => {
    for (const u of [
      "https://staging.acme.dev/x",
      "https://preview.acme.dev",
      "https://acme-git-x.vercel.app/",
      "http://localhost:5173/",
      "http://127.0.0.1:3000",
    ]) {
      expect(classify(u).kind).toBe("environment");
    }
    expect(classify("https://staging.acme.dev/x").title).toBe("Staging acme.dev");
    expect(classify("https://example.com/some/page")).toMatchObject({ kind: "other", title: "example.com/…/page" });
    expect(classify("not a url")).toMatchObject({ kind: "other", title: "not a url" });
  });

  it("only http and https are URLs", () => {
    expect(isHttpUrl("https://a.dev")).toBe(true);
    expect(isHttpUrl("HTTP://a.dev/x")).toBe(true);
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "ftp://a.dev", "https://", "a.dev", ""]) {
      expect(isHttpUrl(u)).toBe(false);
    }
  });
});

describe("links", () => {
  it("ids come from the url, or from the key without one", () => {
    expect(linkId("https://a.dev", null)).toBe(linkId("https://a.dev", "X-1"));
    expect(linkId("https://a.dev", null)).not.toBe(linkId("https://b.dev", null));
    expect(linkId("", "PAY-1")).not.toBe(linkId("", "PAY-2"));
    expect(linkId("https://a.dev", null)).toMatch(/^l[0-9a-f]{16}$/);
  });

  it("makeLink classifies, trims and honours a title", () => {
    const l = makeLink("  https://linear.app/a/issue/ENG-1/x ", undefined, "paste");
    expect(l).toMatchObject({ kind: "issue", provider: "linear", key: "ENG-1", title: "ENG-1", source: "paste" });
    expect(l.url).toBe("https://linear.app/a/issue/ENG-1/x");
    expect(makeLink("https://a.dev/z", "  Mine ", "manual").title).toBe("Mine");
  });

  it("sameLink compares url or key", () => {
    const a = makeLink("https://linear.app/a/issue/ENG-1/x", undefined, "manual");
    const b = { ...makeLink("https://linear.app/b/issue/ENG-1/y", undefined, "branch") };
    expect(sameLink(a, b)).toBe(true);
    expect(sameLink(a, makeLink("https://a.dev", undefined, "manual"))).toBe(false);
    const empty = { ...a, url: "", key: null };
    expect(sameLink(empty, { ...b, url: "", key: null })).toBe(false);
  });

  it("only manual and pasted links can be removed", () => {
    const l = makeLink("https://a.dev", undefined, "manual");
    expect(removable(l)).toBe(true);
    expect(removable({ ...l, source: "paste" })).toBe(true);
    for (const source of ["branch", "commit", "repo"] as const) expect(removable({ ...l, source })).toBe(false);
  });

  it("groups by kind in a fixed order, stable inside a kind", () => {
    const mk = (url: string, title: string) => ({ ...makeLink(url, title, "manual") });
    const ls = [
      mk("https://staging.a.dev", "env"),
      mk("https://a.dev/1", "other1"),
      mk("https://linear.app/a/issue/ENG-1/x", "issue1"),
      mk("https://a.dev/2", "other2"),
      mk("https://linear.app/a/issue/ENG-2/x", "issue2"),
    ];
    expect(groupLinks(ls).map((l) => l.title)).toEqual(["issue1", "issue2", "env", "other1", "other2"]);
  });

  it("top bar: issue keys first, then up to three links, +N for the rest", () => {
    const issue = (n: number) => makeLink(`https://linear.app/a/issue/ENG-${n}/x`, undefined, "branch");
    const other = (n: number) => makeLink(`https://a.dev/${n}`, undefined, "manual");
    const few = topBarChips(groupLinks([issue(1), other(1), other(2)]));
    expect(few.shown.map((l) => l.title)).toEqual(["ENG-1", "a.dev/1", "a.dev/2"]);
    expect(few.more).toBe(0);
    const many = topBarChips(groupLinks([issue(1), issue(2), issue(3), other(1), other(2), other(3), other(4), other(5)]));
    expect(many.shown.map((l) => l.title)).toEqual(["ENG-1", "ENG-2", "a.dev/1", "a.dev/2", "a.dev/3"]);
    expect(many.more).toBe(3);
    expect(topBarChips([])).toEqual({ shown: [], more: 0 });
  });

  it("a short secondary text: the key when the title differs, else the host", () => {
    const pr: Link = { ...makeLink("https://github.com/a/b/pull/3", "Add refunds", "manual") };
    expect(linkSub(pr)).toBe("a/b#3");
    expect(linkSub(makeLink("https://acme.atlassian.net/browse/PAY-1", undefined, "branch"))).toBe("acme.atlassian.net");
    expect(linkSub({ ...pr, key: null, url: "" })).toBe("");
  });
});
