import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../public/schema.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const EFSchema = context.globalThis.EFSchema;

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", message);
  }
}

const truncated = '{"name":"Booking","fields":[{"name":"email","label":"Email","type":"email","required":true,"help":"We only use this to confirm."}';
const recovered = EFSchema.recoverSchema(truncated);
assert(recovered.ok && recovered.schema.fields[0].help.startsWith("We only"), "repairs a truncated fields object and keeps help");

const prose = 'Here is the form.\n{"name":"Contact","fields":[{"name":"name","label":"Name","type":"text","required":true}]}\nThanks.';
assert(EFSchema.recoverSchema(prose).ok, "pulls the fields object out of prose");

const empty = "I could not decide.";
assert(EFSchema.recoverSchema(empty).ok === false, "no fields stays a failure");

const starter = EFSchema.fallbackSchema("i need a form for dog grooming busines called bitches and bubbles");
assert(starter.ok && starter.schema.name === "bitches and bubbles", "starter form keeps the business name");
assert(starter.schema.fields.some((f) => f.name === "petName"), "grooming starter includes a pet field");
console.log("schema recover tests passed");
