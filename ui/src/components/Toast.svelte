<script lang="ts">
  import { app } from "../lib/app.svelte";
</script>

{#if app.toastState}
  {#key app.toastState.id}
    <div class="toast" role="status">{app.toastState.text}</div>
  {/key}
{/if}

<style>
  .toast {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 30;
    padding: 10px 14px;
    border-radius: 12px;
    background: var(--fg);
    color: var(--bg);
    font-weight: 500;
    font-size: 13px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    animation: pop 260ms var(--ease);
  }
</style>
