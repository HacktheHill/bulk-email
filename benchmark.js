const { performance } = require("perf_hooks");

const template = "Hello {{ firstName }}, welcome to {{ eventName }}! Your role is {{ role }}.";
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

const iterations = 100000;

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
