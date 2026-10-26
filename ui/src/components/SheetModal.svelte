<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/app.svelte";

  const spec = $derived(app.sheet);
  let value = $state("");
  let acked = $state(false);
  let problem = $state("");
  let input: HTMLInputElement | undefined = $state();
  let cancel: HTMLButtonElement | undefined = $state();
  let ok: HTMLButtonElement | undefined = $state();

  onMount(() => {
    const s = app.sheet;
    if (!s) return;
    if (s.kind === "prompt") {
      value = s.value;
      input?.focus();
      input?.select();
    } else {
      // A destructive sheet starts on Cancel, so a stray Enter cannot confirm it.
      (s.danger ? cancel : ok)?.focus();
    }
  });

  async function submit(e?: Event) {
    e?.preventDefault();
    const s = app.sheet;
    if (!s) return;
    if (s.kind === "prompt") {
      const bad = s.validate?.(value) ?? null;
      if (bad) {
        problem = bad;
        input?.focus();
        return;
      }
      app.closeOverlay();
      await s.run(value);
    } else {
      if (s.ack && !acked) return;
      app.closeOverlay();
      await s.run();
    }
  }
</script>

{#if spec}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => e.target === e.currentTarget && app.closeOverlay()}>
    <div class="sheet small" role={spec.kind === "confirm" ? "alertdialog" : "dialog"} aria-label={spec.title} aria-modal="true">
      <form class="form" onsubmit={submit}>
        <div class="title">{spec.title}</div>
        {#if spec.kind === "confirm"}
          <p class="body">{spec.body}</p>
          {#if spec.items?.length}
            <ul class="lost" aria-label="What changes">
              {#each spec.items as line (line)}<li class="mono">{line}</li>{/each}
            </ul>
          {/if}
          {#if spec.ack}
            <label class="ack"><input type="checkbox" bind:checked={acked} /> {spec.ack}</label>
          {/if}
          <div class="acts">
            <button type="button" class="btn" bind:this={cancel} onclick={() => app.closeOverlay()}>Cancel</button>
            <button type="submit" class="btn" class:danger={spec.danger} class:p={!spec.danger} bind:this={ok} disabled={!!spec.ack && !acked}>{spec.confirmLabel}</button>
          </div>
        {:else}
          <div class="grp">
            <label for="sheet-in">{spec.label}</label>
            <input
              id="sheet-in"
              class="field"
              autocomplete="off"
              spellcheck="false"
              bind:this={input}
              bind:value
              oninput={() => (problem = "")}
              aria-invalid={problem ? true : undefined}
            />
            {#if problem}<span class="problem" role="alert">{problem}</span>{:else if spec.hint}<span class="cost">{spec.hint}</span>{/if}
          </div>
          <div class="acts">
            <button type="button" class="btn" onclick={() => app.closeOverlay()}>Cancel</button>
            <button type="submit" class="btn p">{spec.submitLabel}</button>
          </div>
        {/if}
      </form>
    </div>
  </div>
{/if}

<style>
  .sheet.small {
    max-width: 460px;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
  }
  .body {
    margin: 0;
    color: var(--muted);
  }
  .lost {
    margin: 0;
    padding: 8px 10px;
    list-style: none;
    max-height: 180px;
    overflow: auto;
    background: var(--raised);
    border-radius: 10px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lost li {
    overflow-wrap: anywhere;
  }
  .ack {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    font-weight: 500;
    color: var(--fg);
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .problem {
    font-size: 12px;
    color: var(--del);
  }
  .btn.danger {
    background: var(--del);
    color: var(--on-accent);
  }
  .btn.danger:hover {
    filter: brightness(1.08);
  }
</style>
