import { expect } from "@esm-bundle/chai";

import "../build/ecad-viewer.js";
import schematicFixture from "../static/design_blocks/2.kicad_sch";

type EcadSourceUpdate = {
    revisionKey: string;
    sources: Array<{ filename: string; content: string }>;
};

type MountedViewer = HTMLElement & {
    replaceSources(update: EcadSourceUpdate): Promise<void>;
    showPage(pageId: string): Promise<void>;
    focusBBox(x: number, y: number, w: number, h: number): Promise<unknown>;
    resize(): void;
    setViewportInsets(
        insets: {
            left?: number;
            right?: number;
            top?: number;
            bottom?: number;
        } | null,
    ): void;
    project: {
        active_sch_name?: string;
        file_by_name(name: string): { generator_version?: string } | undefined;
    };
};

type MountedDocumentViewer = {
    canvas: HTMLCanvasElement;
    paint_count: number;
    viewport: {
        width: number;
        height: number;
        camera: {
            viewport_size: { x: number; y: number };
            fit_insets: {
                left: number;
                right: number;
                top: number;
                bottom: number;
            };
            fit_viewport_center: { x: number; y: number };
            screen_to_world(point: { x: number; y: number }): {
                x: number;
                y: number;
            };
            world_to_screen(point: { x: number; y: number }): {
                x: number;
                y: number;
            };
        };
    };
};

function schematicViewer(host: MountedViewer): MountedDocumentViewer {
    const app = host.shadowRoot?.querySelector("kc-schematic-app") as
        | (HTMLElement & { viewer?: MountedDocumentViewer })
        | null;
    expect(app?.viewer).to.exist;
    return app!.viewer!;
}

function revision(revisionKey: string, content: string): EcadSourceUpdate {
    return {
        revisionKey,
        sources: [{ filename: "board.kicad_sch", content }],
    };
}

suite("warm source replacement", () => {
    let host: MountedViewer;

    setup(() => {
        host = document.createElement("ecad-viewer") as MountedViewer;
        host.setAttribute("source-mode", "host");
        host.style.width = "900px";
        host.style.height = "600px";
        document.body.append(host);
    });

    teardown(() => host.remove());

    test("keeps one mounted host and makes rapid switches newest-wins", async () => {
        const source = schematicFixture;
        await host.replaceSources(revision("initial", source));

        const retainedProject = host.project;
        const retainedApp = (host.querySelector("kc-schematic-app") ??
            host.shadowRoot?.querySelector("kc-schematic-app")) as
            | (HTMLElement & {
                  viewer?: { canvas?: HTMLCanvasElement };
              })
            | null;
        const retainedCanvas = retainedApp?.viewer?.canvas;
        expect(retainedApp).to.exist;
        expect(retainedCanvas).to.exist;
        expect(host.isConnected).to.equal(true);

        const oldRequest = host.replaceSources(
            revision(
                "old",
                source.replace(
                    '(generator_version "9.0")',
                    '(generator_version "9.1")',
                ),
            ),
        );
        const newestRequest = host.replaceSources(
            revision(
                "newest",
                source.replace(
                    '(generator_version "9.0")',
                    '(generator_version "9.2")',
                ),
            ),
        );

        const [oldResult, newestResult] = await Promise.allSettled([
            oldRequest,
            newestRequest,
        ]);
        expect(oldResult.status).to.equal("rejected");
        expect(newestResult.status).to.equal("fulfilled");
        expect(host.project).to.equal(retainedProject);
        const currentApp = (host.querySelector("kc-schematic-app") ??
            host.shadowRoot?.querySelector("kc-schematic-app")) as
            | (HTMLElement & {
                  viewer?: { canvas?: HTMLCanvasElement };
              })
            | null;
        expect(currentApp).to.equal(retainedApp);
        expect(currentApp?.viewer?.canvas).to.equal(retainedCanvas);
        expect(document.querySelectorAll("ecad-viewer")).to.have.length(1);

        const active = host.project.file_by_name("board.kicad_sch");
        expect(active?.generator_version).to.equal("9.2");
        expect(host.project.active_sch_name).to.contain("board.kicad_sch");
    });

    test("synchronizes camera and canvas aspect after a host pane resize", async () => {
        await host.replaceSources(revision("initial", schematicFixture));
        const viewer = schematicViewer(host);
        const paintCount = viewer.paint_count;

        host.style.width = "450px";
        host.resize();

        expect(viewer.canvas.clientWidth).to.equal(450);
        expect(viewer.viewport.camera.viewport_size.x).to.equal(450);
        expect(viewer.viewport.camera.viewport_size.y).to.equal(
            viewer.canvas.clientHeight,
        );
        expect(viewer.canvas.width / viewer.canvas.height).to.be.closeTo(
            viewer.canvas.clientWidth / viewer.canvas.clientHeight,
            0.01,
        );
        expect(viewer.paint_count).to.equal(paintCount);
    });

    test("preserves the visible focal point while applying measured overlay insets", async () => {
        await host.replaceSources(revision("initial", schematicFixture));
        const viewer = schematicViewer(host);
        const camera = viewer.viewport.camera;
        const oldSafeCenter = camera.fit_viewport_center;
        const focalPoint = camera.screen_to_world(oldSafeCenter);
        const paintCount = viewer.paint_count;

        host.setViewportInsets({ left: 180, right: 96, top: 24 });

        expect(camera.fit_insets).to.deep.equal({
            left: 180,
            right: 96,
            top: 24,
            bottom: 0,
        });
        const projected = camera.world_to_screen(focalPoint);
        expect(projected.x).to.be.closeTo(camera.fit_viewport_center.x, 0.01);
        expect(projected.y).to.be.closeTo(camera.fit_viewport_center.y, 0.01);
        expect(viewer.paint_count).to.equal(paintCount);

        await host.replaceSources(revision("next", schematicFixture));
        expect(schematicViewer(host).viewport.camera.fit_insets).to.deep.equal({
            left: 180,
            right: 96,
            top: 24,
            bottom: 0,
        });
    });

    test("fits focused bounds inside the unobscured viewport", async () => {
        await host.replaceSources(revision("initial", schematicFixture));
        host.setViewportInsets({ left: 180, right: 120, top: 30, bottom: 50 });

        await host.focusBBox(0, 0, 100, 100);

        const camera = schematicViewer(host).viewport.camera;
        const topLeft = camera.world_to_screen({ x: 0, y: 0 });
        const bottomRight = camera.world_to_screen({ x: 100, y: 100 });
        expect(topLeft.x).to.be.at.least(180 - 0.01);
        expect(topLeft.y).to.be.at.least(30 - 0.01);
        expect(bottomRight.x).to.be.at.most(900 - 120 + 0.01);
        expect(bottomRight.y).to.be.at.most(600 - 50 + 0.01);
    });

    test("traces resolved pages and rejects silent page misses", async () => {
        const events: Array<{
            event: string;
            requestedPage?: string;
            resolvedPage?: { filename: string } | null;
        }> = [];
        host.addEventListener("ecad-viewer:transition-trace", ((
            event: CustomEvent,
        ) => {
            events.push(event.detail);
        }) as EventListener);
        await host.replaceSources(revision("initial", schematicFixture));

        await host.showPage("./board.kicad_sch/");
        const failure = await Promise.allSettled([
            host.showPage("/S32G399/Boot & Low Speed Interfaces/"),
        ]);

        expect(failure[0]?.status).to.equal("rejected");
        expect(
            events.some(
                (event) =>
                    event.event === "page.show.complete" &&
                    event.resolvedPage?.filename === "board.kicad_sch",
            ),
        ).to.equal(true);
        expect(
            events.some(
                (event) =>
                    event.event === "page.show.failed" &&
                    event.requestedPage ===
                        "/S32G399/Boot & Low Speed Interfaces/",
            ),
        ).to.equal(true);
    });
});
