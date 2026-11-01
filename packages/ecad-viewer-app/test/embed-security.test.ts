/**
 * Embedding hardening: URL configuration and the postMessage bridge are
 * standalone-only, the bridge only listens to its parent on an allowed
 * origin, a host-mode viewer ignores bridged ZIPs, and a board is never
 * posted anywhere when it renders.
 */
import { expect } from "@esm-bundle/chai";

import "../build/ecad-viewer.js";

import {
    is_standalone_host,
    load_ecad_viewer_conf,
    safe_link_url,
    same_origin_url,
} from "../src/ecad-viewer/ecad_viewer_global";
import { setup_iframe_bridge } from "../src/ecad-viewer/iframe_bridge";
import {
    LOAD_ZIP_MESSAGE_TYPE,
    LoadZipEvent,
} from "../src/viewers/base/events";

const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
  (segment (start 5 10) (end 15 10) (width 0.25) (layer "F.Cu") (net 0) (uuid "seg"))
)
`;

const BASE = "https://prism.example/project/1?x=1";

suite("embed security: configuration", function () {
    test("standalone mode needs the meta opt-in", function () {
        const doc = document.implementation.createHTMLDocument("");
        expect(is_standalone_host(doc)).to.equal(false);
        const meta = doc.createElement("meta");
        meta.name = "ecad-viewer-mode";
        meta.content = "embedded";
        doc.head.append(meta);
        expect(is_standalone_host(doc)).to.equal(false);
        meta.content = "standalone";
        expect(is_standalone_host(doc)).to.equal(true);
    });

    test("this page did not opt in, so the bundle read no URL config", function () {
        expect(is_standalone_host()).to.equal(false);
        expect(window.cli_server_addr).to.equal(undefined);
        expect(window.ai_url).to.equal(undefined);
    });

    test("link targets must be https or on the page's origin", function () {
        expect(safe_link_url("https://ok.example/a", BASE)).to.equal(
            "https://ok.example/a",
        );
        expect(safe_link_url("/about", BASE)).to.equal(
            "https://prism.example/about",
        );
        expect(safe_link_url("javascript:alert(1)", BASE)).to.equal(undefined);
        expect(safe_link_url(" JavaScript:alert(1)", BASE)).to.equal(undefined);
        expect(safe_link_url("data:text/html,x", BASE)).to.equal(undefined);
        expect(safe_link_url("http://plain.example/", BASE)).to.equal(
            undefined,
        );
        expect(
            safe_link_url("//evil.example/x", "http://local.test/"),
        ).to.equal(undefined);
        expect(safe_link_url("", BASE)).to.equal(undefined);
    });

    test("an upload server must be on the page's origin", function () {
        expect(same_origin_url("/convert", BASE)).to.equal(
            "https://prism.example/convert",
        );
        expect(same_origin_url("https://attacker.example/x", BASE)).to.equal(
            undefined,
        );
        expect(same_origin_url("//attacker.example/x", BASE)).to.equal(
            undefined,
        );
    });

    test("standalone config drops a foreign server and unsafe link", function () {
        try {
            load_ecad_viewer_conf(
                new URLSearchParams({
                    "cli-server-addr": "https://attacker.example/upload",
                    "ai-url": "javascript:alert(1)",
                }),
            );
            expect(window.cli_server_addr).to.equal(undefined);
            expect(window.ai_url).to.equal(undefined);

            load_ecad_viewer_conf(
                new URLSearchParams({
                    "cli-server-addr": "/convert",
                    "ai-url": "https://ok.example/",
                }),
            );
            expect(window.cli_server_addr).to.equal(
                new URL("/convert", window.location.href).href,
            );
            expect(window.ai_url).to.equal("https://ok.example/");
        } finally {
            delete window.cli_server_addr;
            delete window.ai_url;
        }
    });
});

suite("embed security: iframe bridge", function () {
    let parent: HTMLIFrameElement;
    let stranger: HTMLIFrameElement;
    let loads: Blob[];
    const onLoad = (e: Event) => loads.push((e as LoadZipEvent).detail);
    const zip = () => new Blob(["PK"], { type: "application/zip" });

    suiteSetup(function () {
        parent = document.createElement("iframe");
        stranger = document.createElement("iframe");
        document.body.append(parent, stranger);
        setup_iframe_bridge({
            parent: parent.contentWindow!,
            allowedOrigins: ["https://prism.example"],
        });
        window.addEventListener(LoadZipEvent.type, onLoad);
    });

    suiteTeardown(function () {
        window.removeEventListener(LoadZipEvent.type, onLoad);
        parent.remove();
        stranger.remove();
        delete window.zip_url;
    });

    setup(function () {
        loads = [];
    });

    function send(source: Window, origin: string) {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: LOAD_ZIP_MESSAGE_TYPE, blob: zip() },
                origin,
                source,
            }),
        );
    }

    test("accepts the parent on an allowed origin", function () {
        send(parent.contentWindow!, "https://prism.example");
        expect(loads).to.have.length(1);
    });

    test("ignores the parent on another origin", function () {
        send(parent.contentWindow!, "https://attacker.example");
        expect(loads).to.have.length(0);
    });

    test("ignores another window on an allowed origin", function () {
        send(stranger.contentWindow!, "https://prism.example");
        expect(loads).to.have.length(0);
    });
});

type Host = HTMLElement & {
    replaceSources(update: {
        revisionKey: string;
        sources: Array<{ filename: string; content: string }>;
    }): Promise<void>;
    ready: Promise<void>;
    load_zip(file: Blob): Promise<void>;
};

suite("embed security: host-mode viewer", function () {
    this.timeout(20000);

    test("renders a board without posting it and ignores bridged ZIPs", async function () {
        const originalFetch = window.fetch;
        const posted: string[] = [];
        const announced: Event[] = [];
        const announce = (e: Event) => announced.push(e);
        window.cli_server_addr = "https://attacker.example/upload";
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method ?? "GET").toUpperCase() === "POST")
                posted.push(String(input));
            return originalFetch(input, init);
        }) as typeof fetch;
        window.addEventListener("pcb:board_content:ready", announce);

        const host = document.createElement("ecad-viewer") as Host;
        try {
            host.setAttribute("show-header", "false");
            host.setAttribute("source-mode", "host");
            host.style.width = "600px";
            host.style.height = "400px";
            await customElements.whenDefined("ecad-viewer");
            document.body.append(host);
            await host.replaceSources({
                revisionKey: "rev-1",
                sources: [{ filename: "board.kicad_pcb", content: BOARD }],
            });
            await host.ready;
            for (
                let i = 0;
                i < 200 && !host.shadowRoot?.querySelector("kc-board-app");
                i++
            )
                await new Promise((resolve) => setTimeout(resolve, 25));
            expect(host.shadowRoot?.querySelector("kc-board-app")).not.equal(
                null,
            );
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(posted).to.deep.equal([]);
            expect(announced).to.have.length(0);

            let zipLoads = 0;
            host.load_zip = async () => {
                zipLoads++;
            };
            window.dispatchEvent(new LoadZipEvent(new Blob(["PK"])));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(zipLoads).to.equal(0);
        } finally {
            host.remove();
            window.fetch = originalFetch;
            window.removeEventListener("pcb:board_content:ready", announce);
            delete window.cli_server_addr;
        }
    });
});
