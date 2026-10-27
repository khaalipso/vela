<script lang="ts">
  import { keyText } from "../lib/platform";

  let { k }: { k: string } = $props();
</script>

<kbd>{keyText(k)}</kbd>
