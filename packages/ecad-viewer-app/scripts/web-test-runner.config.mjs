import { fileURLToPath } from "node:url";

import { defaultReporter, summaryReporter } from "@web/test-runner";
import { chromeLauncher } from "@web/test-runner-chrome";
import { esbuildPlugin } from "@web/dev-server-esbuild";

// https://modern-web.dev/docs/test-runner/cli-and-configuration/

export default {
    files: "test/**/*.test.ts",
    nodeResolve: true,
    debugger: false,
    browsers: [chromeLauncher({ concurrency: 1 })],
    plugins: [
        esbuildPlugin({
            ts: true,
            target: "es2022",
            // The app relies on `useDefineForClassFields: false` — several
            // painters redeclare a base class's constructor-assigned property
            // purely to narrow its type. Without the tsconfig, esbuild emits
            // those as real field definitions that overwrite the constructor's
            // value with `undefined`, and tests that exercise src/ directly
            // (rather than the prebuilt bundle) fall over.
            tsconfig: fileURLToPath(
                new URL("../tsconfig.json", import.meta.url),
            ),
            loaders: {
                ".js": "ts",
                ".glsl": "text",
                ".css": "text",
                ".kicad_pcb": "text",
                ".kicad_sch": "text",
                ".kicad_wks": "text",
                ".kicad_pro": "text",
            },
        }),
    ],
    reporters: [
        defaultReporter({ reportTestResults: true, reportTestProgress: true }),
        summaryReporter(),
    ],
    testFramework: {
        config: {
            ui: "tdd",
        },
    },
};
