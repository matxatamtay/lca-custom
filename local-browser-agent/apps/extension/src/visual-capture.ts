import type { CaptureOptions } from "../../../packages/protocol/src/index.js";

export const ESSENTIAL_COMPUTED_STYLES = [
  "display", "visibility", "opacity", "position", "z-index", "box-sizing",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "color", "background-color", "background-image", "box-shadow",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-align", "text-decoration-line", "text-transform", "white-space",
  "overflow-x", "overflow-y", "cursor", "pointer-events",
  "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "gap",
  "grid-template-columns", "grid-template-rows", "grid-auto-flow"
] as const;

export const FULL_COMPUTED_STYLES = [
  ...ESSENTIAL_COMPUTED_STYLES,
  "inset", "top", "right", "bottom", "left", "float", "clear",
  "aspect-ratio", "object-fit", "object-position",
  "outline-width", "outline-style", "outline-color", "outline-offset",
  "background-position", "background-size", "background-repeat", "background-clip",
  "filter", "backdrop-filter", "mix-blend-mode", "isolation",
  "transform", "transform-origin", "perspective",
  "transition-property", "transition-duration", "animation-name", "animation-duration",
  "text-overflow", "word-break", "overflow-wrap", "tab-size",
  "list-style-type", "list-style-position",
  "column-count", "column-gap",
  "order", "flex-grow", "flex-shrink", "flex-basis", "align-self",
  "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
  "place-content", "place-items", "place-self",
  "contain", "content-visibility", "will-change",
  "scroll-margin-top", "scroll-margin-right", "scroll-margin-bottom", "scroll-margin-left",
  "scroll-padding-top", "scroll-padding-right", "scroll-padding-bottom", "scroll-padding-left"
] as const;

export function computedStylesForMode(mode: CaptureOptions["styleMode"]): string[] {
  if (mode === "none") return [];
  return [...(mode === "full" ? FULL_COMPUTED_STYLES : ESSENTIAL_COMPUTED_STYLES)];
}

export function visualSnapshotExpression(): string {
  const rootProperties = JSON.stringify([...ESSENTIAL_COMPUTED_STYLES]);
  return `(() => {
    const properties = ${rootProperties};
    const styleOf = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]).filter(([, value]) => value));
    };
    const describe = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        id: element.id || null,
        classes: Array.from(element.classList || []).slice(0, 50),
        role: element.getAttribute?.('role') || null,
        name: element.getAttribute?.('aria-label') || element.getAttribute?.('name') || null,
        text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    };
    const selection = getSelection();
    return {
      viewport: {
        innerWidth, innerHeight, outerWidth, outerHeight,
        devicePixelRatio, scrollX, scrollY,
        visualViewport: visualViewport ? {
          width: visualViewport.width, height: visualViewport.height,
          offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
          pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop,
          scale: visualViewport.scale
        } : null
      },
      document: {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        direction: document.dir || getComputedStyle(document.documentElement).direction,
        language: document.documentElement.lang || navigator.language
      },
      media: {
        colorSchemeDark: matchMedia('(prefers-color-scheme: dark)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        highContrast: matchMedia('(prefers-contrast: more)').matches,
        forcedColors: matchMedia('(forced-colors: active)').matches,
        pointerCoarse: matchMedia('(pointer: coarse)').matches,
        hoverAvailable: matchMedia('(hover: hover)').matches
      },
      rootStyle: styleOf(document.documentElement),
      bodyStyle: styleOf(document.body),
      activeElement: describe(document.activeElement),
      selection: selection ? {
        text: String(selection).slice(0, 2_000),
        rangeCount: selection.rangeCount,
        anchorNode: selection.anchorNode?.nodeName || null,
        focusNode: selection.focusNode?.nodeName || null
      } : null,
      fonts: document.fonts ? Array.from(document.fonts).slice(0, 200).map((font) => ({
        family: font.family, style: font.style, weight: font.weight, stretch: font.stretch, status: font.status
      })) : [],
      historyLength: history.length
    };
  })()`;
}
