<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { stackColor } from "../lib/format";
  import { spaceBranches } from "../lib/types";
  import type { StackItem } from "../lib/types";

  const label = (s: StackItem) => (s.version ? `${s.name} ${s.version}` : s.name);
  const detail = (s: StackItem) => [s.source, ...(s.ports?.map((p) => `:${p}`) ?? []), s.state === "stopped" ? "old" : ""].filter(Boolean).join(" ");
</script>

<div class="pop" role="dialog" aria-label="Stack">
  <div class="psec">Stack for {spaceBranches(app.space).join(", ")}</div>
  {#each app.sd.stack as s (s.name + s.version + s.source)}
    <div class="r">
      <span class="dot" style:--c={stackColor(s.state)}></span>
      <span class="mono">{label(s)}</span>
      <span class="m">{detail(s)}</span>
    </div>
  {/each}
  <div class="psec">Each worktree gets its own containers and ports</div>
</div>

<style>
  .pop {
    position: absolute;
    right: 6px;
    bottom: 40px;
    z-index: 7;
    width: 300px;
    background: var(--panel);
    border-radius: 14px;
    padding: 10px;
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.4),
      0 0 0 1px var(--line);
    display: flex;
    flex-direction: column;
    gap: 4px;
    animation: pop 240ms var(--ease);
  }
  .r {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    font-size: 13px;
  }
  .m {
    margin-left: auto;
    font-size: 12px;
    color: var(--faint);
    font-family: var(--code);
  }
</style>
