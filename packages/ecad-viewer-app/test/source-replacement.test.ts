import { expect } from "@esm-bundle/chai";

import "../build/ecad-viewer.js";
import schematicFixture from "../static/design_blocks/2.kicad_sch";

type EcadSourceUpdate = {
    revisionKey: string;
    sources: Array<{ filename: string; content: string }>;
};

type EcadComparisonRequest = {
    comparisonKey: string;
    reference: EcadSourceUpdate;
    comparison: EcadSourceUpdate;
    diff: unknown;
    diffFormat: "prism";
    documentPath: string;
    referenceSheetPath?: string;
    comparisonSheetPath?: string;
    activeSheetPath?: string;
};

type SchematicPageState = {
    projectPath: string;
    sheetPath: string;
    filename: string;
    parentProjectPath?: string;
    active: boolean;
};

type MountedViewer = HTMLElement & {
    replaceSources(update: EcadSourceUpdate): Promise<void>;
    loadDocumentComparison(request: EcadComparisonRequest): Promise<{
        targets: ReadonlyMap<
            string,
            { bounds: [number, number, number, number] }
        >;
        resolution: {
            targets: number;
            targetsWithPaintedBounds: number;
            targetsUsingProvidedBounds: number;
            targetsNonFocusable: number;
        };
    }>;
    prepareComparison(request: EcadComparisonRequest): Promise<{
        setPresentation(
            presentation: "composite" | "reference" | "comparison",
            viewport?: MountedViewer,
        ): Promise<{
            switchMs: number;
            parserCount: number;
            paintCount: number;
        }>;
        getMetrics(): {
            parserCount: number;
            switchCount: number;
            lastSwitchParserCount: number;
            retainedViewports: number;
            retainedScenes: number;
        };
        getSchematicPages(): {
            reference: SchematicPageState[];
            comparison: SchematicPageState[];
        };
        dispose(): void;
    }>;
    selectDocumentDiff(selection: {
        kind: "change" | "group";
        id: string;
    }): Promise<{ status: "applied" | "missing" | "superseded" }>;
    showPage(pageId: string): Promise<void>;
    getActiveSchematicPage(): SchematicPageState | null;
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
    draw(): void;
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

    test("ignores a late draw after the host has been disposed", async () => {
        await host.replaceSources(revision("initial", schematicFixture));
        const viewer = schematicViewer(host);

        host.remove();
        viewer.draw();
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );
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

    test("measures Prism identity-only targets from the painted scene", async () => {
        const sourceId = "08c9fb50-bb86-43e9-b87c-3df8063952e8";
        const result = await host.loadDocumentComparison({
            comparisonKey: "m5:painted",
            reference: revision("m5-reference", schematicFixture),
            comparison: revision("m5-comparison", schematicFixture),
            diffFormat: "prism",
            documentPath: "board.kicad_sch",
            diff: {
                documents: [
                    {
                        path: "board.kicad_sch",
                        docType: "kicad_sch",
                        changes: [
                            {
                                id: `/${sourceId}`,
                                typeName: "SCH_SYMBOL",
                                kind: "modified",
                                properties: [],
                                children: [],
                            },
                        ],
                    },
                ],
            },
        });
        const target = result.targets.get(`change:/${sourceId}`);

        expect(result.resolution).to.deep.include({
            targets: 2,
            targetsWithPaintedBounds: 2,
            targetsUsingProvidedBounds: 0,
            targetsNonFocusable: 0,
        });
        expect(target).to.exist;
        expect(target!.bounds).not.to.deep.equal([0, 0, 0, 0]);
        expect(
            await host.selectDocumentDiff({
                kind: "change",
                id: `/${sourceId}`,
            }),
        ).to.deep.include({ status: "applied" });
    });

    test("keeps an unresolved Prism identity non-focusable", async () => {
        const sourceId = "00000000-0000-0000-0000-000000000000";
        const result = await host.loadDocumentComparison({
            comparisonKey: "m5:missing",
            reference: revision("m5-missing-reference", schematicFixture),
            comparison: revision("m5-missing-comparison", schematicFixture),
            diffFormat: "prism",
            documentPath: "board.kicad_sch",
            diff: {
                documents: [
                    {
                        path: "board.kicad_sch",
                        docType: "kicad_sch",
                        changes: [
                            {
                                id: `/${sourceId}`,
                                typeName: "SCH_SYMBOL",
                                kind: "modified",
                                properties: [],
                                children: [],
                            },
                        ],
                    },
                ],
            },
        });

        expect(result.resolution).to.deep.include({
            targets: 2,
            targetsWithPaintedBounds: 0,
            targetsUsingProvidedBounds: 0,
            targetsNonFocusable: 2,
        });
        expect(result.targets.size).to.equal(0);
        expect(
            await host.selectDocumentDiff({
                kind: "change",
                id: `/${sourceId}`,
            }),
        ).to.deep.include({ status: "missing" });
    });

    test("drives two revision viewports from one prepared session without reparsing", async function () {
        const sourceId = "08c9fb50-bb86-43e9-b87c-3df8063952e8";
        const repeatedDisposals: unknown[][] = [];
        const originalTrace = console.trace;
        console.trace = (...args: unknown[]) => {
            if (
                args[0] === "dispose() called on an already disposed resource"
            ) {
                repeatedDisposals.push(args);
                return;
            }
            originalTrace(...args);
        };
        const secondary = document.createElement(
            "ecad-viewer",
        ) as MountedViewer;
        secondary.setAttribute("source-mode", "host");
        secondary.style.width = "900px";
        secondary.style.height = "600px";
        document.body.append(secondary);
        try {
            const request: EcadComparisonRequest = {
                comparisonKey: "m6:shared-session",
                reference: revision("m6-reference", schematicFixture),
                comparison: revision("m6-comparison", schematicFixture),
                diffFormat: "prism",
                documentPath: "board.kicad_sch",
                diff: {
                    documents: [
                        {
                            path: "board.kicad_sch",
                            docType: "kicad_sch",
                            changes: [
                                {
                                    id: `/${sourceId}`,
                                    typeName: "SCH_SYMBOL",
                                    kind: "modified",
                                    sourceSide: "comparison",
                                    properties: [],
                                    children: [
                                        {
                                            id: `/${sourceId}`,
                                            typeName: "SCH_SYMBOL",
                                            kind: "modified",
                                            sourceSide: "reference",
                                            properties: [],
                                            children: [],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            };
            const session = await host.prepareComparison(request);

            const [reference, comparison] = await Promise.all([
                session.setPresentation("reference", host),
                session.setPresentation("comparison", secondary),
            ]);
            const composite = await session.setPresentation("composite", host);
            const warmReference = await session.setPresentation(
                "reference",
                host,
            );
            const metrics = session.getMetrics();

            expect(reference.parserCount).to.equal(0);
            expect(comparison.parserCount).to.equal(0);
            expect(reference.switchMs).to.be.lessThan(150);
            expect(comparison.switchMs).to.be.lessThan(150);
            expect(composite.parserCount).to.equal(0);
            expect(composite.paintCount).to.equal(0);
            expect(composite.switchMs).to.be.lessThan(150);
            expect(warmReference.parserCount).to.equal(0);
            expect(warmReference.paintCount).to.equal(0);
            expect(warmReference.switchMs).to.be.lessThan(150);
            expect(metrics.lastSwitchParserCount).to.equal(0);
            expect(metrics.maxSwitchMs).to.be.lessThan(150);
            expect(metrics.retainedViewports).to.equal(2);
            // Exact side-instance activation may retain the owner's reference
            // and comparison project scenes in addition to Composite. Keep the
            // bound explicit so the page fix cannot grow the cache unbounded.
            expect(metrics.retainedScenes).to.be.within(3, 4);
            expect(document.querySelectorAll("ecad-viewer")).to.have.length(2);
            expect(
                await host.selectDocumentDiff({
                    kind: "change",
                    id: `/${sourceId}`,
                }),
            ).to.deep.include({ status: "applied" });
            expect(
                await secondary.selectDocumentDiff({
                    kind: "change",
                    id: `/${sourceId}`,
                }),
            ).to.deep.include({ status: "applied" });
            session.dispose();
            session.dispose();

            // A selected page creates a new session over the same two mounted
            // hosts. Adopting its new project model must not rebuild and
            // reconnect an otherwise unchanged custom-element shell.
            const replacement = await host.prepareComparison({
                ...request,
                comparisonKey: "m6:replacement-page-session",
                reference: revision("m6-reference-next", schematicFixture),
                comparison: revision("m6-comparison-next", schematicFixture),
            });
            await replacement.setPresentation("comparison", secondary);
            replacement.dispose();
            replacement.dispose();
            expect(repeatedDisposals).to.have.length(0);
        } finally {
            console.trace = originalTrace;
            await new Promise<void>((resolve) =>
                window.setTimeout(resolve, 50),
            );
            secondary.remove();
        }
    }).timeout(10_000);

    test("catalogs both revisions and activates each side's exact sheet instance", async function () {
        const referenceUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const comparisonUuid = "42e3b81c-e97d-4030-acfe-87c608ff8c69";
        const referenceSource = schematicFixture.replace(
            `(uuid "${comparisonUuid}")`,
            `(uuid "${referenceUuid}")`,
        );
        const referencePath = `board.kicad_sch:/${referenceUuid}`;
        const comparisonPath = `board.kicad_sch:/${comparisonUuid}`;
        const session = await host.prepareComparison({
            comparisonKey: "m7:side-specific-sheet",
            reference: revision("m7-reference", referenceSource),
            comparison: revision("m7-comparison", schematicFixture),
            diffFormat: "prism",
            documentPath: "board.kicad_sch",
            referenceSheetPath: referencePath,
            comparisonSheetPath: comparisonPath,
            activeSheetPath: "board.kicad_sch",
            diff: {
                documents: [
                    {
                        path: "board.kicad_sch",
                        docType: "kicad_sch",
                        changes: [],
                    },
                ],
            },
        });

        const catalogs = session.getSchematicPages();
        expect(catalogs.reference[0]).to.deep.include({
            projectPath: referencePath,
            parentProjectPath: undefined,
            active: true,
        });
        expect(catalogs.comparison[0]).to.deep.include({
            projectPath: comparisonPath,
            parentProjectPath: undefined,
            active: true,
        });

        await session.setPresentation("reference", host);
        expect(host.getActiveSchematicPage()?.projectPath).to.equal(
            referencePath,
        );
        await session.setPresentation("comparison", host);
        expect(host.getActiveSchematicPage()?.projectPath).to.equal(
            comparisonPath,
        );
        session.dispose();
    });
});
