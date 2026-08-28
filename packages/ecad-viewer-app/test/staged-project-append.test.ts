import { expect } from "@esm-bundle/chai";

import "../build/ecad-viewer.js";

/**
 * Project settings that arrive after the sheet they belong to.
 *
 * A host does not necessarily have every file at once. Prism loads the root
 * schematic first so something is on screen, then appends the `.kicad_pro` and
 * the subsheets as they arrive. Text variables are resolved while painting, so
 * a sheet painted before its project settings landed drew `${VERSION}`
 * verbatim and kept drawing it: appending files reloaded the project but
 * deliberately did not re-render, and re-issuing the same document is a no-op
 * in DocumentViewer. Navigating to another sheet and back forced a repaint and
 * the value appeared -- which is exactly how this was reported.
 */

const SHEET = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (paper "A4")
  (title_block (title "Board") (rev "\${VERSION}"))
  (text "Build \${VERSION}" (at 50 50 0)
    (effects (font (size 2 2)))
    (uuid "00000000-0000-0000-0000-0000000000t1"))
)
`;

const PROJECT = JSON.stringify({
    text_variables: { VERSION: "3.7.1" },
});

type SourceUpdate = {
    revisionKey: string;
    sources: Array<{ filename: string; content: string }>;
};

type Host = HTMLElement & {
    replaceSources(update: SourceUpdate): Promise<void>;
    appendSources(update: SourceUpdate): Promise<void>;
    project: { resolve_text_var(name: string): string | undefined };
};

function schematic_viewer(host: Host) {
    const app = host.shadowRoot?.querySelector("kc-schematic-app") as
        | (HTMLElement & {
              viewer?: { paint_count: number; document: unknown };
          })
        | null;
    expect(app?.viewer, "schematic viewer").to.exist;
    return app!.viewer!;
}

suite("appending project settings after the sheet", () => {
    let host: Host;

    setup(() => {
        host = document.createElement("ecad-viewer") as Host;
        host.setAttribute("source-mode", "host");
        host.style.width = "900px";
        host.style.height = "600px";
        document.body.append(host);
    });

    teardown(() => host.remove());

    test("the sheet is repainted when its .kicad_pro arrives", async () => {
        await host.replaceSources({
            revisionKey: "r1",
            sources: [{ filename: "board.kicad_sch", content: SHEET }],
        });

        const viewer = schematic_viewer(host);
        const painted_before = viewer.paint_count;
        expect(
            host.project.resolve_text_var("VERSION"),
            "no settings loaded yet",
        ).to.equal(undefined);

        await host.appendSources({
            revisionKey: "r1",
            sources: [{ filename: "board.kicad_pro", content: PROJECT }],
        });

        expect(host.project.resolve_text_var("VERSION")).to.equal("3.7.1");
        expect(
            viewer.paint_count,
            "the sheet kept the text it painted before the project arrived",
        ).to.be.greaterThan(painted_before);
    });

    test("appending unrelated files does not force a repaint", async () => {
        // Subsheets arrive on this same path and are far more numerous than
        // project files. Repainting for each would rebuild the scene once per
        // sheet on every load.
        await host.replaceSources({
            revisionKey: "r2",
            sources: [{ filename: "board.kicad_sch", content: SHEET }],
        });
        const viewer = schematic_viewer(host);
        const painted_before = viewer.paint_count;

        await host.appendSources({
            revisionKey: "r2",
            sources: [{ filename: "sub.kicad_sch", content: SHEET }],
        });

        expect(viewer.paint_count).to.equal(painted_before);
    });

    test("re-appending the same project file does no extra work", async () => {
        await host.replaceSources({
            revisionKey: "r3",
            sources: [{ filename: "board.kicad_sch", content: SHEET }],
        });
        await host.appendSources({
            revisionKey: "r3",
            sources: [{ filename: "board.kicad_pro", content: PROJECT }],
        });
        const viewer = schematic_viewer(host);
        const painted_before = viewer.paint_count;

        await host.appendSources({
            revisionKey: "r3",
            sources: [{ filename: "board.kicad_pro", content: PROJECT }],
        });

        expect(viewer.paint_count).to.equal(painted_before);
    });
});
