import type { AgentRole, AgentStatus, StackState } from "./types";
import { hslToHex } from "./colors";

export const uniq = <T>(a: T[]): T[] => a.filter((x, i) => a.indexOf(x) === i);

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const ROLES: AgentRole[] = ["developer", "reviewer", "tester", "planner", "debugger", "product", "security"];

export function roleLabel(role: AgentRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const TOOLS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  crush: "Crush",
};

export function toolLabel(tool: string): string {
  return TOOLS[tool] ?? tool;
}

/** Tool the mock uses for a role the user asks for. */
export function toolForRole(role: AgentRole): string {
  return role === "reviewer" ? "codex" : role === "tester" ? "opencode" : "claude";
}

/** Colors by role, using the design tokens. */
export const ROLE_COLORS: Record<AgentRole, string> = {
  developer: "var(--info)",
  reviewer: "var(--warn)",
  tester: "var(--add)",
  planner: "var(--syn-alt)",
  debugger: "var(--del)",
  product: "var(--space)",
  security: "var(--warn)",
};

export function agentStatusColor(s: AgentStatus): string {
  return s === "working"
    ? "var(--info)"
    : s === "waiting"
      ? "var(--space)"
      : s === "failed"
        ? "var(--del)"
        : s === "interrupted"
          ? "var(--warn)"
          : "var(--add)";
}

export function stackColor(s: StackState): string {
  return s === "ok"
    ? "var(--add)"
    : s === "starting"
      ? "var(--warn)"
      : s === "unknown"
        ? "var(--info)"
        : s === "missing"
          ? "var(--del)"
          : "var(--faint)";
}

/** Names of the commit gate checks, in order, so the sheet can list them before results arrive. */
export const GATE_NAMES = ["Reviewer", "Tests touched by the diff", "Lint and types", "Secrets and .env", "Repo rules"];

export const fileKey =(repo: string, path: string): string => `${repo}/${path}`;

const AGENT_NAMES = [
  "Alan", "Ada", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Edsger", "Radia", "Donald", "Hedy",
  "Niklaus", "Frances", "Tim", "Katherine", "Bjarne", "Sophie", "Guido", "Joan", "Rob", "Anita", "Brian", "Lynn",
  "Leslie", "Mary", "Vint", "Jean", "Claude", "Shafi", "Yukihiro", "Marissa", "John", "Evelyn", "Larry", "Dorothy",
  "Ray", "Carol", "Fred", "Irene", "Walter", "Nadia", "Paul", "Elena", "Martin", "Clara", "Hugo", "Iris",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A first name for an agent, stable for its id: it ties a request to an agent ("Alan - Tester"). */
export function agentName(id: string): string {
  return AGENT_NAMES[hash(id) % AGENT_NAMES.length];
}

/** A soft color per tag: same tag, same color, calm saturation so a row of tags never shouts. */
export function tagColor(tag: string): string {
  return hslToHex((hash(tag.toLowerCase()) % 12) * 30 + 8, 42, 66);
}
