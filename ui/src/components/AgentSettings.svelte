<script lang="ts">
  // Agent settings, in two tabs:
  // - Tiers: model and reasoning effort of the high, medium and low tiers of each harness.
  // - Prompts: the brief each role gets before the request.
  // Both are written to the global config (~/.config/vela/config.toml). The sheet opens at
  // once with what was loaded last; fresh values replace them when they arrive.
  import { tick } from "svelte";
  import { app } from "../lib/app.svelte";
  import { renderBranch, type HarnessTiers, type TierSetting } from "../lib/backend";
  import { ROLE_COLORS, roleLabel, ROLES } from "../lib/format";
  import type { AgentRole, Tier } from "../lib/types";

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

  // -- branches --
  let tplDraft = $state<string | null>(null);
  async function saveTpl() {
    if (tplDraft === null) return;
    await app.setBranchTemplate(tplDraft);
    tplDraft = null;
  }

  // -- prompts --
  let role = $state<AgentRole>(app.role);
  let draft = $state("");
  let editor: HTMLTextAreaElement | undefined = $state();
  const current = $derived(app.rolePrompts.find((p) => p.role === role));
  const dirty = $derived(!!current && draft.trim() !== (current.custom ?? current.default).trim());

  // Load the brief of the picked role into the editor (and when the prompts arrive).
  let loadedFor = "";
  $effect(() => {
    const p = current;
    const key = p ? `${p.role}:${p.custom ?? ""}:${p.default.length}` : "";
    if (p && key !== loadedFor) {
      loadedFor = key;
      draft = p.custom ?? p.default;
    }
  });

  async function pick(r: AgentRole) {
    role = r;
    loadedFor = "";
    await tick();
    editor?.focus();
  }

  function onEditorKey(e: KeyboardEvent) {
    if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void app.setPrompt(role, draft);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
  <div class="sheet wide" role="dialog" aria-label="Agent settings">
    <header class="sh">
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={app.settingsTab === "tiers"} onclick={() => (app.settingsTab = "tiers")}>Tiers</button>
        <button role="tab" aria-selected={app.settingsTab === "prompts"} onclick={() => (app.settingsTab = "prompts")}>Prompts</button>
        <button
          role="tab"
          aria-selected={app.settingsTab === "branches"}
          onclick={() => {
            app.settingsTab = "branches";
            void app.loadBranchChoices(null);
          }}>Branches</button
        >
      </div>
      <span class="sub">
        {app.settingsTab === "branches"
          ? "How the branch of a new space is named. You can still type any branch, or pick an existing one, when you create a space."
          : app.settingsTab === "tiers"
          ? "Which model and how much reasoning each tier gets, per tool. Empty keeps the tool's default."
          : "The brief each role gets before your request. Vela always puts its ground rules first (investigate before answering, cite files and lines, never commit) and the space context after."}
      </span>
    </header>

    {#if app.settingsTab === "branches"}
      <div class="list branches" aria-label="Branch naming">
        <label>
          <span>Pattern</span>
          <input
            value={tplDraft ?? app.branchTemplate}
            aria-label="Branch pattern"
            spellcheck="false"
            oninput={(e) => (tplDraft = (e.currentTarget as HTMLInputElement).value)}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveTpl();
              }
            }}
          />
        </label>
        <p class="hint">
          <code>{"{slug}"}</code> the space name as a slug · <code>{"{user}"}</code> your user name · <code>{"{date}"}</code> today (YYYY-MM-DD).
          Examples: <button class="ex" onclick={() => (tplDraft = "feat/{slug}")}>feat/{"{slug}"}</button>
          <button class="ex" onclick={() => (tplDraft = "{user}/{slug}")}>{"{user}"}/{"{slug}"}</button>
          <button class="ex" onclick={() => (tplDraft = "{date}-{slug}")}>{"{date}"}-{"{slug}"}</button>
        </p>
        <p class="preview">"Refunds in checkout" → <b class="mono">{renderBranch(tplDraft ?? app.branchTemplate, "Refunds in checkout")}</b></p>
        <div class="acts">
          <span class="hint">The branch of an existing space: click it in the top bar to rename it.</span>
          <button class="btn p" disabled={tplDraft === null || tplDraft === app.branchTemplate} onclick={saveTpl}>Save</button>
        </div>
      </div>
    {:else if app.settingsTab === "tiers"}
      <div class="list" aria-label="Agent tiers">
        {#if !app.tierSettings.length}
          {#each [0, 1, 2] as i (i)}<div class="skel"></div>{/each}
        {/if}
        {#each app.tierSettings as h (h.harness)}
          <section class="h" class:off={!h.available}>
            <h4>{h.label}{#if !h.available}<small>not installed</small>{/if}</h4>
            <datalist id="models-{h.harness}">
              {#each app.modelsOf(h) as m (m)}<option value={m}></option>{/each}
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
    {:else}
      <div class="prompts" aria-label="Agent prompts">
        <nav class="roles">
          {#each ROLES as r (r)}
            {@const p = app.rolePrompts.find((x) => x.role === r)}
            <button class:on={r === role} onclick={() => pick(r)}>
              <span class="dot" style:--c={ROLE_COLORS[r]}></span>
              {roleLabel(r)}
              {#if p?.custom}<small>edited</small>{/if}
            </button>
          {/each}
        </nav>
        <div class="ed">
          {#if current}
            <textarea
              bind:this={editor}
              bind:value={draft}
              spellcheck="false"
              aria-label="{roleLabel(role)} brief"
              onkeydown={onEditorKey}
            ></textarea>
            {#if current.notes}
              <p class="hint">Vela adds after it: how to write findings as NOTE lines, so they show on the code in the Review view.</p>
            {/if}
            <div class="acts">
              <span class="hint">{current.custom ? "Your brief" : "Built in brief"}{dirty ? " · not saved" : ""}</span>
              {#if current.custom}
                <button class="btn" onclick={() => app.setPrompt(role, null)}>Reset to built in</button>
              {/if}
              <button class="btn p" disabled={!dirty} onclick={() => app.setPrompt(role, draft)}>Save <kbd>Ctrl S</kbd></button>
            </div>
          {:else}
            <div class="skel tall"></div>
          {/if}
        </div>
      </div>
    {/if}

    <div class="pfoot">
      <span>{app.tierSettings[0]?.file ? `Saved in ${app.tierSettings[0].file}` : "Saved in the global config"}. A repo's .vela/config.toml can override it.</span>
      <button class="btn" onclick={() => app.closeOverlay()}>Done <kbd>Esc</kbd></button>
    </div>
  </div>
</div>

<style>
  .wide {
    max-width: 820px;
  }
  .sh {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px 4px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 10px;
    background: var(--raised);
    align-self: flex-start;
  }
  .tabs button {
    height: 28px;
    padding: 0 14px;
    border-radius: 7px;
    font-size: 13px;
    color: var(--muted);
  }
  .tabs button[aria-selected="true"] {
    background: var(--hover);
    color: var(--fg);
  }
  .sub {
    color: var(--muted);
    font-size: 13px;
  }
  .list {
    padding: 4px 16px 12px;
    max-height: 64vh;
    overflow: auto;
  }
  .skel {
    height: 96px;
    margin: 12px 0;
    border-radius: 10px;
    background: linear-gradient(90deg, var(--raised), var(--hover), var(--raised));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  .skel.tall {
    height: 300px;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
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
  select,
  textarea {
    background: var(--raised);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 5px 8px;
    font-size: 13px;
    font-family: var(--code);
    outline: none;
  }
  input:focus,
  select:focus,
  textarea:focus {
    border-color: var(--space);
  }
  .branches {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
  }
  .branches input {
    font-size: 14px;
    padding: 7px 10px;
  }
  .branches code {
    font-family: var(--code);
    font-size: 12px;
    background: var(--raised);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .ex {
    font-family: var(--code);
    font-size: 12px;
    color: var(--info);
    padding: 0 4px;
  }
  .preview {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }
  .mono {
    font-family: var(--code);
  }
  .prompts {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    gap: 12px;
    padding: 8px 16px 12px;
  }
  .roles {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .roles button {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--muted);
    text-align: left;
  }
  .roles button:hover,
  .roles button.on {
    background: var(--hover);
    color: var(--fg);
  }
  .roles small {
    margin-left: auto;
    font-size: 10px;
    color: var(--space);
  }
  .ed {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  textarea {
    min-height: 260px;
    max-height: 52vh;
    resize: vertical;
    line-height: 1.55;
    padding: 10px 12px;
    font-size: 12.5px;
  }
  .hint {
    margin: 0;
    color: var(--faint);
    font-size: 12px;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .acts .hint {
    margin-right: auto;
  }
  kbd {
    font-family: var(--code);
    font-size: 11px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--hover);
  }
  @media (max-width: 640px) {
    .row,
    .branches {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
  }
  .branches input {
    font-size: 14px;
    padding: 7px 10px;
  }
  .branches code {
    font-family: var(--code);
    font-size: 12px;
    background: var(--raised);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .ex {
    font-family: var(--code);
    font-size: 12px;
    color: var(--info);
    padding: 0 4px;
  }
  .preview {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }
  .mono {
    font-family: var(--code);
  }
  .prompts {
      grid-template-columns: 1fr;
    }
  }
</style>
