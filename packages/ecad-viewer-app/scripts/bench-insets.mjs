/*
    Board inset benchmark (Visualizer insets, IN-02).

    Serve the app first (`ECAD_VIEWER_PORT=8016 npm run serve`), make the
    board reachable under static/ (e.g. symlink it into the gitignored
    static/ecad_viewer/_scratch/), then:

      node scripts/bench-insets.mjs \
        --pcb ecad_viewer/_scratch/eda/EDA-04903-V1-0.kicad_pcb \
        --pads C387:1,IC12:21,U1:1 [--port 8016] [--steps 30]

    Prints JSON: per pad the first frame, steady main-thread time and GPU
    time per inset frame (GPU via a 1-px readPixels sync), plus a full
    main-view frame for reference. Timings are at the page's DPR (2).
*/

import puppeteer from "puppeteer-core";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
};
const port = arg("port", "8016");
const cull = arg("cull", "1");
const pcb = arg("pcb");
const steps = Number(arg("steps", 30));
// --frame REF:PAD,...: render all of these in one frame (IN-51 gate).
const frame_pads = (arg("frame", "") || "")
    .split(",")
    .filter(Boolean)
    .map((p) => p.split(":"));
const pads = (arg("pads", "") || "")
    .split(",")
    .filter(Boolean)
    .map((p) => p.split(":"));
if (!pcb || (!pads.length && !frame_pads.length)) {
    console.error(
        "usage: bench-insets.mjs --pcb <url> --pads REF:PAD[,REF:PAD]",
    );
    process.exit(2);
}

const browser = await puppeteer.launch({
    executablePath:
        process.env.CHROME ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
    args: ["--enable-webgl", "--ignore-gpu-blocklist"],
});
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    const t0 = Date.now();
    await page.goto(
        `http://127.0.0.1:${port}/bench-insets.html?pcb=${encodeURIComponent(pcb)}&cull=${cull}`,
    );
    await page.waitForFunction(() => typeof window.bench_ready === "function");
    await page.evaluate(() => window.bench_ready());
    const result = { pcb, load_ms: Date.now() - t0, pads: [] };
    for (const [reference, number] of pads)
        result.pads.push(
            await page.evaluate(
                (r, n, s) => window.bench_pad(r, n, s),
                reference,
                number,
                steps,
            ),
        );
    if (frame_pads.length)
        result.frame = await page.evaluate(
            (p) => window.bench_frame(p),
            frame_pads,
        );
    result.main_view = await page.evaluate(() => window.bench_main());
    result.cull = cull !== "0";
    result.pixels = await page.evaluate(() => window.bench_pixels());
    console.log(JSON.stringify(result, null, 1));
} finally {
    await browser.close();
}
