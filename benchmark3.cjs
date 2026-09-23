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

const PLACEHOLDER_REGEX = /\{\{\s*(\w+)\s*\}\}/g;

function applyExtractedFastPath(input, values) {
    // Note: V8 optimizes Regexes with literals, so fast-pathing is only needed if there's no clear prefix
    // But let's benchmark string.includes first vs direct RegExp
    if (!input.includes("{{")) return input;
    return input.replaceAll(PLACEHOLDER_REGEX, (_match, key) => {
        const value = values[key];
        return String(value);
    });
}

function applyExtracted(input, values) {
    return input.replaceAll(PLACEHOLDER_REGEX, (_match, key) => {
        const value = values[key];
        return String(value);
    });
}

const iterations = 1000000;

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
