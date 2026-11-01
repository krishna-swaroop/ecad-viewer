import { expect } from "@esm-bundle/chai";

import { ParseCache } from "../src/kicanvas/parse_cache";

/** A run() whose promise settles when told to, counting its calls. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

suite("parse cache", function () {
    test("concurrent requests for one key share one run", async function () {
        const cache = new ParseCache(24, 1000);
        const d = deferred<string>();
        let runs = 0;
        const run = () => {
            runs += 1;
            return d.promise;
        };
        const a = cache.get_or_run("k", 10, run);
        const b = cache.get_or_run("k", 10, run);
        d.resolve("pod");
        expect(await a).to.equal("pod");
        expect(await b).to.equal("pod");
        expect(runs).to.equal(1);
        expect([cache.hits, cache.misses]).to.deep.equal([1, 1]);
    });

    test("keeps settled entries within the budget", async function () {
        const cache = new ParseCache(24, 1000);
        await cache.get_or_run("k", 400, async () => "pod");
        await settle();
        expect(cache.has("k")).to.equal(true);
        expect(cache.bytes).to.equal(400);
    });

    test("evicts the least recently used past the byte budget", async function () {
        const cache = new ParseCache(24, 1000);
        await cache.get_or_run("a", 400, async () => "a");
        await cache.get_or_run("b", 400, async () => "b");
        // Touch "a" so "b" is now the oldest.
        await cache.get_or_run("a", 400, async () => "unused");
        await cache.get_or_run("c", 400, async () => "c");
        expect(cache.has("a")).to.equal(true);
        expect(cache.has("b")).to.equal(false);
        expect(cache.has("c")).to.equal(true);
        expect(cache.bytes).to.equal(800);
    });

    test("shares an oversized file while in flight, then drops it", async function () {
        const cache = new ParseCache(24, 1000);
        const d = deferred<string>();
        let runs = 0;
        const run = () => {
            runs += 1;
            return d.promise;
        };
        const a = cache.get_or_run("big", 5000, run);
        const b = cache.get_or_run("big", 5000, run);
        expect(runs).to.equal(1);
        d.resolve("pod");
        await Promise.all([a, b]);
        await settle();
        expect(cache.has("big")).to.equal(false);
        expect(cache.bytes).to.equal(0);
    });

    test("an oversized file does not push smaller entries out", async function () {
        const cache = new ParseCache(24, 1000);
        await cache.get_or_run("small", 600, async () => "s");
        await cache.get_or_run("big", 5000, async () => "b");
        await settle();
        expect(cache.has("small")).to.equal(true);
        expect(cache.bytes).to.equal(600);
    });

    test("forgets a failed run", async function () {
        const cache = new ParseCache(24, 1000);
        const failed = cache.get_or_run("k", 10, async () => {
            throw new Error("parse failed");
        });
        try {
            await failed;
        } catch {
            // expected
        }
        await settle();
        expect(cache.has("k")).to.equal(false);
        expect(cache.bytes).to.equal(0);
    });

    test("still caps the number of entries", async function () {
        const cache = new ParseCache(2, 1_000_000);
        for (const k of ["a", "b", "c"])
            await cache.get_or_run(k, 1, async () => k);
        expect([cache.has("a"), cache.has("b"), cache.has("c")]).to.deep.equal([
            false,
            true,
            true,
        ]);
    });
});
