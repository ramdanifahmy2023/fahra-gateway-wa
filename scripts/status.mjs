import { processStates } from "./lib/process-state.mjs";
const state = await processStates();
process.stdout.write(
  `OpenClaw WhatsApp Gateway Status\nRunner: ${state.mode}\n\n`,
);
if (!state.services.length) process.stdout.write("Tidak ada service aktif.\n");
else console.table(state.services);
