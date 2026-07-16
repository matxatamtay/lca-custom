import { z } from "zod";

export const PROTOCOL_VERSION = 3;

export const TabTargetSchema = z.union([z.literal("active"), z.number().int().positive()]);

export const ElementTargetSchema = z.object({
  selector: z.string().min(1).max(2_000).optional(),
  text: z.string().min(1).max(1_000).optional(),
  role: z.string().min(1).max(100).optional(),
  name: z.string().max(1_000).optional(),
  backendNodeId: z.number().int().positive().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional()
}).superRefine((value, context) => {
  const hasCoordinates = value.x !== undefined || value.y !== undefined;
  if (hasCoordinates && (value.x === undefined || value.y === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Both x and y are required for coordinate targeting." });
  }
  if (!value.selector && !value.text && !value.role && !value.backendNodeId && !hasCoordinates) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide selector, text, role, backendNodeId, or x/y coordinates." });
  }
});

export type ElementTarget = z.infer<typeof ElementTargetSchema>;

export const BrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inspect"),
    element: ElementTargetSchema,
    includeMatchedStyles: z.boolean().default(true)
  }),
  z.object({
    kind: z.literal("click"),
    element: ElementTargetSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).default([])
  }),
  z.object({ kind: z.literal("hover"), element: ElementTargetSchema }),
  z.object({ kind: z.literal("focus"), element: ElementTargetSchema }),
  z.object({
    kind: z.literal("type"),
    element: ElementTargetSchema,
    text: z.string().max(200_000),
    clear: z.boolean().default(false)
  }),
  z.object({
    kind: z.literal("press"),
    element: ElementTargetSchema.optional(),
    key: z.string().min(1).max(100),
    code: z.string().max(100).optional(),
    text: z.string().max(10_000).optional(),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).default([])
  }),
  z.object({
    kind: z.literal("scroll"),
    element: ElementTargetSchema.optional(),
    deltaX: z.number().finite().min(-100_000).max(100_000).default(0),
    deltaY: z.number().finite().min(-100_000).max(100_000).default(600)
  }),
  z.object({
    kind: z.literal("select"),
    element: ElementTargetSchema,
    values: z.array(z.string()).min(1).max(100)
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(120_000) })
]);

export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const CaptureIncludeSchema = z.enum([
  "screenshot",
  "html",
  "dom",
  "console",
  "network",
  "performance",
  "accessibility",
  "devtools",
  "visual"
]);

export const CaptureOptionsSchema = z.object({
  target: TabTargetSchema.default("active"),
  include: z.array(CaptureIncludeSchema).default([
    "screenshot",
    "dom",
    "console",
    "network",
    "performance",
    "accessibility",
    "devtools",
    "visual"
  ]),
  screenshot: z.enum(["none", "viewport", "full"]).default("viewport"),
  dom: z.enum(["none", "summary", "interactive", "full"]).default("interactive"),
  styleMode: z.enum(["none", "essential", "full"]).default("essential"),
  sinceMs: z.number().int().min(0).max(3_600_000).default(30_000),
  maxItems: z.number().int().min(1).max(5_000).default(500),
  maxDomNodes: z.number().int().min(100).max(100_000).default(20_000),
  maxHtmlChars: z.number().int().min(10_000).max(32_000_000).default(8_000_000),
  bodyPolicy: z.enum(["none", "text-small"]).default("none"),
  redact: z.boolean().default(true)
});

export type CaptureOptions = z.infer<typeof CaptureOptionsSchema>;

export const NavigationOptionsSchema = z.object({
  target: TabTargetSchema.default("active"),
  url: z.string().min(1).max(20_000),
  waitUntil: z.enum(["none", "domcontentloaded", "load", "networkidle"]).default("load"),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(45_000),
  waitAfterMs: z.number().int().min(0).max(30_000).default(300),
  captureAfter: z.boolean().default(true),
  capture: CaptureOptionsSchema.partial().optional(),
  redact: z.boolean().default(true)
});

export type NavigationOptions = z.infer<typeof NavigationOptionsSchema>;

export const InteractionOptionsSchema = z.object({
  target: TabTargetSchema.default("active"),
  action: BrowserActionSchema,
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  waitAfterMs: z.number().int().min(0).max(30_000).default(300),
  captureAfter: z.boolean().default(true),
  capture: CaptureOptionsSchema.partial().optional(),
  redact: z.boolean().default(true)
});

export type InteractionOptions = z.infer<typeof InteractionOptionsSchema>;

export const TabSummarySchema = z.object({
  id: z.number().int().positive(),
  windowId: z.number().int(),
  active: z.boolean(),
  title: z.string(),
  url: z.string(),
  origin: z.string().nullable(),
  incognito: z.boolean(),
  status: z.string().nullable().optional()
});

export type TabSummary = z.infer<typeof TabSummarySchema>;

export const ScreenshotPayloadSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z.string(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional()
});

export const HtmlPayloadSchema = z.object({
  markup: z.string(),
  baseUrl: z.string(),
  title: z.string(),
  truncated: z.boolean(),
  originalChars: z.number().int().nonnegative(),
  capturedAt: z.string(),
  sanitization: z.record(z.unknown()).default({})
});

export const CapturePayloadSchema = z.object({
  tab: TabSummarySchema,
  mode: z.enum(["agent", "devtools", "limited"]),
  capturedAt: z.string(),
  coverage: z.record(z.unknown()).default({}),
  screenshot: ScreenshotPayloadSchema.optional(),
  html: HtmlPayloadSchema.optional(),
  dom: z.unknown().optional(),
  console: z.array(z.unknown()).optional(),
  network: z.array(z.unknown()).optional(),
  performance: z.unknown().optional(),
  accessibility: z.unknown().optional(),
  devtools: z.unknown().optional(),
  visual: z.unknown().optional(),
  warnings: z.array(z.string()).default([])
});

export type CapturePayload = z.infer<typeof CapturePayloadSchema>;

export const BrowserOperationResultSchema = z.object({
  tab: TabSummarySchema,
  mode: z.enum(["agent", "devtools", "limited"]),
  operation: z.enum(["navigate", "interact"]),
  startedAt: z.string(),
  completedAt: z.string(),
  result: z.unknown().optional(),
  debug: z.unknown().optional(),
  warnings: z.array(z.string()).default([]),
  capture: CapturePayloadSchema.optional()
});

export type BrowserOperationResult = z.infer<typeof BrowserOperationResultSchema>;

export const BridgeClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    extensionId: z.string().min(1),
    extensionVersion: z.string().min(1),
    browserVersion: z.string().optional(),
    capabilities: z.array(z.string()).default([]),
    token: z.string().optional()
  }),
  z.object({
    type: z.literal("pair"),
    requestId: z.string().min(1),
    code: z.string().regex(/^\d{6}$/),
    extensionId: z.string().min(1)
  }),
  z.object({
    type: z.literal("result"),
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional()
  }),
  z.object({
    type: z.literal("progress"),
    requestId: z.string().min(1),
    stage: z.string(),
    completed: z.number().min(0).max(1).optional(),
    message: z.string().optional()
  }),
  z.object({
    type: z.literal("chunk"),
    requestId: z.string().min(1),
    artifact: z.string().min(1),
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
    sha256: z.string().optional()
  }),
  z.object({
    type: z.literal("event"),
    event: z.string().min(1),
    payload: z.unknown().optional()
  })
]);

export type BridgeClientMessage = z.infer<typeof BridgeClientMessageSchema>;

export const BridgeServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    authenticated: z.boolean(),
    pairingRequired: z.boolean(),
    serverVersion: z.string(),
    sessionId: z.string().optional()
  }),
  z.object({
    type: z.literal("paired"),
    requestId: z.string().min(1),
    token: z.string().min(20),
    sessionId: z.string().min(1),
    expiresAt: z.string()
  }),
  z.object({
    type: z.literal("command"),
    requestId: z.string().min(1),
    command: z.enum(["status", "listTabs", "capture", "navigate", "interact", "cancel"]),
    args: z.unknown().optional()
  }),
  z.object({
    type: z.literal("error"),
    requestId: z.string().optional(),
    code: z.string(),
    message: z.string()
  }),
  z.object({
    type: z.literal("ping"),
    nonce: z.string()
  })
]);

export type BridgeServerMessage = z.infer<typeof BridgeServerMessageSchema>;

export function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
