const { createHash } = require("crypto");
const { performance } = require("perf_hooks");

const emails = [];
for (let i = 0; i < 10000; i++) {
    emails.push(`user${i}@example.com`);
}

const accepted = new Set();
for (let i = 0; i < 5000; i++) {
    accepted.add(createHash("sha256").update(emails[i], "utf8").digest("hex"));
}

let start = performance.now();
for (let i = 0; i < 100; i++) {
    const hasAccepted = accepted.size > 0;
    for (const email of emails) {
        if (hasAccepted && accepted.has(createHash("sha256").update(email, "utf8").digest("hex"))) {
            continue;
        }
    }
}
console.log("Without fast path (always hash if accepted has size > 0):", performance.now() - start, "ms");

const acceptedEmpty = new Set();
start = performance.now();
for (let i = 0; i < 100; i++) {
    const hasAccepted = acceptedEmpty.size > 0;
    for (const email of emails) {
        if (hasAccepted && acceptedEmpty.has(createHash("sha256").update(email, "utf8").digest("hex"))) {
            continue;
        }
    }
}
console.log("With fast path (skip if accepted size is 0):", performance.now() - start, "ms");
