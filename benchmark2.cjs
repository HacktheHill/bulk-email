const { performance } = require("perf_hooks");

const template = "Hello {{ firstName }}, welcome to {{ eventName }}! Your role is {{ role }}.";
const template2 = "This has no placeholders.";
const props = { firstName: "Alice", eventName: "Hack the Hill", role: "Hacker" };

function applyInline(input, values) {
    return input.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
        const value = values[key];
        return String(value);
    });
}

const REGEX = /\{\{\s*(\w+)\s*\}\}/g;
function applyExtracted(input, values) {
    return input.replaceAll(REGEX, (_match, key) => {
        const value = values[key];
        return String(value);
    });
}

function applyExtractedFastPath(input, values) {
    if (!input.includes("{{")) return input;
    return input.replaceAll(REGEX, (_match, key) => {
        const value = values[key];
        return String(value);
    });
}

const iterations = 100000;

console.log("With placeholders:");
let start = performance.now();
for (let i = 0; i < iterations; i++) {
    applyInline(template, props);
}
console.log("Inline RegExp:", performance.now() - start, "ms");

start = performance.now();
for (let i = 0; i < iterations; i++) {
    applyExtracted(template, props);
}
console.log("Extracted RegExp:", performance.now() - start, "ms");

start = performance.now();
for (let i = 0; i < iterations; i++) {
    applyExtractedFastPath(template, props);
}
console.log("Extracted RegExp + Fast Path:", performance.now() - start, "ms");

console.log("\nWithout placeholders:");
start = performance.now();
for (let i = 0; i < iterations; i++) {
    applyInline(template2, props);
}
console.log("Inline RegExp:", performance.now() - start, "ms");

start = performance.now();
for (let i = 0; i < iterations; i++) {
    applyExtracted(template2, props);
}
console.log("Extracted RegExp:", performance.now() - start, "ms");

start = performance.now();
for (let i = 0; i < iterations; i++) {
    applyExtractedFastPath(template2, props);
}
console.log("Extracted RegExp + Fast Path:", performance.now() - start, "ms");
