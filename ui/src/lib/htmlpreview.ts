/** Rendering an HTML file as the page it is: the CSS and JS it links are read from the repo and inlined. */

export function isHtml(key: string): boolean {
  return /\.html?$/i.test(key);
}

const REMOTE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** `href` as a path inside the repo, or null when it points elsewhere (a URL, an anchor). */
export function localPath(dir: string, href: string): string | null {
  const clean = href.split(/[?#]/)[0];
  if (!clean || REMOTE.test(clean)) return null;
  const parts: string[] = [];
  for (const seg of (clean.startsWith("/") ? clean : `${dir}${clean}`).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);

/** The page with its local stylesheets and scripts written into it; what cannot be read stays as it is. */
export async function inlineAssets(html: string, path: string, read: (p: string) => Promise<string | null>): Promise<string> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const jobs: Promise<string>[] = [];
  const scan = (re: RegExp, make: (tag: string, text: string) => string, name: "href" | "src", ok: (tag: string) => boolean) => {
    html = html.replace(re, (tag) => {
      const m = ok(tag) ? attr(tag, name) : null;
      const p = m ? localPath(dir, m[2] ?? m[3]) : null;
      if (p === null) return tag;
      const i = jobs.push(read(p).then((t) => (t === null ? tag : make(tag, t)))) - 1;
      return `\u0000${i}\u0000`;
    });
  };
  scan(/<link\b[^>]*>/gi, (_t, css) => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`, "href", (t) => /\brel\s*=\s*["']?stylesheet/i.test(t));
  scan(
    /<script\b[^>]*>\s*<\/script>/gi,
    (tag, js) => `${tag.replace(/\s(src|integrity|crossorigin)\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/<\/script>$/i, "")}${js.replace(/<\/script/gi, "<\\/script")}</script>`,
    "src",
    () => true,
  );
  const done = await Promise.all(jobs);
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => done[Number(i)]);
}
