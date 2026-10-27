<script lang="ts">
  // Model and reasoning effort of the high, medium and low tiers of each harness. Written to
  // the global config (~/.config/vela/config.toml); empty means the harness default.
  import { app } from "../lib/app.svelte";
  import type { HarnessTiers, TierSetting } from "../lib/backend";
  import { roleLabel, ROLES } from "../lib/format";
  import type { Tier } from "../lib/types";

  const TIER_HINT: Record<Tier, string> = {
    high: "Planning, review, security, hard bugs",
    medium: "Implementation",
    low: "Tests, small fixes, Vela's own tasks",
  };

  function rolesOf(tier: Tier): string {
    const d = app.roleDefaults[app.space.id] ?? [];
    const names = ROLES.filter((r) => (d.find((x) => x.role === r)?.tier ?? null) === tier).map(roleLabel);
    return names.length ? names.join(", ") : TIER_HINT[tier];
  }

  function saveModel(h: HarnessTiers, t: TierSetting, value: string) {
    if ((t.model ?? "") === value.trim()) return;
    void app.setTier(h.harness, t.tier, { model: value });
  }
  function saveEffort(h: HarnessTiers, t: TierSetting, value: string) {
    void app.setTier(h.harness, t.tier, { effort: value || null });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet wide" role="dialog" aria-label="Agent tiers">
    <header class="sh">
      <b>Agent tiers</b>
      <span>Which model and how much reasoning each tier gets, per tool. Empty keeps the tool's default.</span>
    </header>
    <div class="list">
      {#each app.tierSettings as h (h.harness)}
        <section class="h" class:off={!h.available}>
          <h4>{h.label}{#if !h.available}<small>not installed</small>{/if}</h4>
          <datalist id="models-{h.harness}">
            {#each h.models as m (m)}<option value={m}></option>{/each}
          </datalist>
          {#each h.tiers as t (t.tier)}
            <div class="row">
              <div class="tier">
                <b>{t.tier.toUpperCase()}</b>
                <small>{rolesOf(t.tier)}</small>
              </div>
              <label>
                <span>Model</span>
                <input
                  list="models-{h.harness}"
                  value={t.model ?? ""}
                  placeholder="default"
                  aria-label="{h.label} {t.tier} model"
                  onchange={(e) => saveModel(h, t, (e.currentTarget as HTMLInputElement).value)}
                  onkeydown={(e) => {
                    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  }}
                />
              </label>
              <label>
                <span>Effort</span>
                <select
                  value={t.effort ?? ""}
                  aria-label="{h.label} {t.tier} effort"
                  onchange={(e) => saveEffort(h, t, (e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">default</option>
                  {#each h.efforts as ef (ef)}<option value={ef}>{ef}</option>{/each}
                </select>
              </label>
            </div>
          {/each}
        </section>
      {/each}
    </div>
    <div class="pfoot">
      <span>{app.tierSettings[0]?.file ? `Saved in ${app.tierSettings[0].file}` : "Saved in the global config"}. A repo's .vela/config.toml can override it.</span>
      <button class="btn" onclick={() => app.closeOverlay()}>Done <kbd>Esc</kbd></button>
    </div>
  </div>
</div>

<style>
  .wide {
    max-width: 760px;
  }
  .sh {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px 16px 4px;
  }
  .sh span {
    color: var(--muted);
    font-size: 13px;
  }
  .list {
    padding: 4px 16px 12px;
    max-height: 64vh;
    overflow: auto;
  }
  .h.off {
    opacity: 0.55;
  }
  h4 {
    margin: 14px 0 6px;
    font-size: 13px;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  h4 small {
    color: var(--faint);
    font-weight: 400;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(150px, 1fr) minmax(0, 1.4fr) 140px;
    gap: 10px;
    align-items: center;
    padding: 6px 0;
    border-top: 1px solid var(--line);
  }
  .tier {
    display: flex;
    flex-direction: column;
  }
  .tier b {
    font-size: 12px;
    letter-spacing: 0.06em;
  }
  .tier small {
    color: var(--faint);
    font-size: 11px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--faint);
  }
  input,
  select {
    background: var(--raised);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 5px 8px;
    font: inherit;
    font-size: 13px;
    font-family: var(--code);
    outline: none;
  }
  input:focus,
  select:focus {
    border-color: var(--space);
  }
  .pfoot kbd {
    font-family: var(--code);
    font-size: 11px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--hover);
  }
  @media (max-width: 640px) {
    .row {
      grid-template-columns: 1fr;
    }
  }
</style>
