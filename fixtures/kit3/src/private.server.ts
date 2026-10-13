import { FIXTURE_PORT, FIXTURE_SECRET } from "$app/env/private";
import { privateEnv } from "sveltekit-effect/config";
export const readPrivate = () => privateEnv(() => ({ PORT: FIXTURE_PORT, SECRET: FIXTURE_SECRET }));
