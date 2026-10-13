import { query } from "$app/server";
import { effect, read } from "../../effect.server";
export const remoteThing = query(effect.handler(() => read));
