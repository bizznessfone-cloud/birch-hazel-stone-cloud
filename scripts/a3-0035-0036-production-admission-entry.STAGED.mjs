#!/usr/bin/env node
// This is a staged entrypoint, not referenced by any active production workflow.
// Requires the exact manual GitHub workflow context, confirmation and approval record.
// Production execution requires a separate explicit user decision and controlled activation.
import { runProductionAdmission } from "./a3-0035-0036-production-admission.STAGED.mjs";
const result = await runProductionAdmission();
console.log(JSON.stringify(result));
if (!result.verdict.startsWith("PASS")) process.exitCode = 2;
