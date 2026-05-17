// Single import surface for the wizard's interactive prompts. If we want to
// swap @inquirer/prompts for something lighter later (clack, readline-sync,
// hand-rolled readline), the change is one file. Keeps the rest of the
// wizard library-agnostic.

export { select, input, confirm } from "@inquirer/prompts";
