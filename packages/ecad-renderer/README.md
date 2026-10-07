# ECAD renderer bundle

`ecad-renderer` draws a parsed KiCad library symbol or footprint into a canvas.
The host owns the canvas and chooses selection and navigation gestures
explicitly; there is no aggregate `interactive` option.

```ts
const result = await renderSymbol(symbol, {
    canvas,
    selectable: true,
    navigation: {
        wheel: "modifier",
        pinch: false,
        touchPan: false,
        drag: true,
    },
    onProbe: (event) => handleProbe(event),
});

result.controller.zoomBy(1.25);
result.controller.resetView();

// Required when the host replaces or unmounts the canvas.
result.dispose();
```

Navigation defaults to disabled. `wheel` accepts `"disabled"`, `"modifier"`,
or `"direct"`; `pinch`, `touchPan`, and `drag` are independent booleans.
`selectable` controls picking and probe events separately from navigation.

Consumers of older experimental bundles must replace `interactive: true` with
the individual options they need. No compatibility alias is provided.
