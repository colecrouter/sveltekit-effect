<script lang="ts">import type { PageData } from "./$types"; let { data }: { data: PageData } = $props();</script>
<p>{data.id}:{data.identity}:{data.remote}</p>

<p>{data.port}:{data.secret}</p>
