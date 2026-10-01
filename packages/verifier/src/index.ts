import { z } from "zod";
import { ActionIR, TaskSpec, BBox } from "../../protocol/src/index.js";
import { EveError } from "../../core/src/index.js";

// ── Grounding verification ───────────────────────────────────────────────────

export const GroundingContext = z.object({
  screenWidth: z.number().int().min(8).max(7680),
  screenHeight: z.number().int().min(8).max(4320),
  edgeDensity: z.number().min(0).max(1).optional(),
});
export type GroundingContext = z.infer<typeof GroundingContext>;

export const GroundingCandidate = z.object({
  regionId: z.string().optional(),
  bbox: BBox,
  score: z.number().min(0).max(1).optional(),
  edgeDensity: z.number().min(0).max(1).optional(),
});
export type GroundingCandidate = z.infer<typeof GroundingCandidate>;

export const GroundingVerdict = z.object({
  passed: z.boolean(),
  reason: z.string().optional(),
  score: z.number().min(0).max(1),
});
export type GroundingVerdict = z.infer<typeof GroundingVerdict>;

export const GroundingVerifierOptions = z.object({
  minSide: z.number().int().min(1).max(256).default(6),
  minAreaFrac: z.number().min(0).max(1).default(0.00002),
  maxAreaFrac: z.number().min(0).max(1).default(0.6),
  maxAspect: z.number().min(1).max(64).default(16),
  minEdge: z.number().min(0).max(1).default(0.02),
});
export type GroundingVerifierOptions = z.infer<typeof GroundingVerifierOptions>;

export function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix0 = Math.max(a[0], b[0]);
  const iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]);
  const iy1 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix1 - ix0 + 1);
  const ih = Math.max(0, iy1 - iy0 + 1);
  const inter = iw * ih;
  if (inter === 0) return 0;
  const areaA = (a[2] - a[0] + 1) * (a[3] - a[1] + 1);
  const areaB = (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
  return inter / (areaA + areaB - inter);
}

/** Rerank + reject loop for grounding proposals. Rejections carry a reason. */
export class GroundingVerifier {
  private readonly opts: GroundingVerifierOptions;

  constructor(optsInput: unknown = {}) {
    this.opts = GroundingVerifierOptions.parse(optsInput);
  }

  verify(candidateInput: unknown, ctxInput: unknown): GroundingVerdict {
    const c = GroundingCandidate.parse(candidateInput);
    const ctx = GroundingContext.parse(ctxInput);
    const [x0, y0, x1, y1] = c.bbox;
    if (x1 < x0 || y1 < y0) {
      return { passed: false, reason: "inverted bbox corners", score: 0 };
    }
    if (x0 < 0 || y0 < 0 || x1 >= ctx.screenWidth || y1 >= ctx.screenHeight) {
      return { passed: false, reason: "bbox outside screen bounds", score: 0 };
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w < this.opts.minSide || h < this.opts.minSide) {
      return { passed: false, reason: `bbox side below minimum ${this.opts.minSide}px`, score: 0 };
    }
    const areaFrac = (w * h) / (ctx.screenWidth * ctx.screenHeight);
    if (areaFrac < this.opts.minAreaFrac) {
      return { passed: false, reason: `bbox area ${areaFrac.toFixed(5)} below minimum`, score: 0 };
    }
    if (areaFrac > this.opts.maxAreaFrac) {
      return { passed: false, reason: `bbox area ${areaFrac.toFixed(4)} exceeds maximum (whole-screen grounding rejected)`, score: 0 };
    }
    const aspect = Math.max(w / h, h / w);
    if (aspect > this.opts.maxAspect) {
      return { passed: false, reason: `aspect ${aspect.toFixed(1)} exceeds maximum`, score: 0 };
    }
    const edge = c.edgeDensity ?? ctx.edgeDensity ?? 1;
    if (edge < this.opts.minEdge) {
      return { passed: false, reason: `edge density ${edge.toFixed(3)} below minimum (blank region)`, score: 0 };
    }
    // size prior: mid-size widgets outrank slivers and full-screen boxes
    const sizePrior = 1 - Math.abs(areaFrac - 0.02) / 0.6;
    const base = c.score ?? 0.5;
    const score = Math.max(0, Math.min(1, base * 0.6 + Math.max(0, Math.min(1, sizePrior)) * 0.25 + Math.min(1, edge * 4) * 0.15));
    return { passed: true, score: Math.round(score * 1000) / 1000 };
  }

  rerank(candidatesInput: unknown, ctxInput: unknown): Array<GroundingCandidate & { verdict: GroundingVerdict }> {
    const list = z.array(GroundingCandidate).parse(candidatesInput);
    const ctx = GroundingContext.parse(ctxInput);
    return list
      .map((c) => ({ ...c, verdict: this.verify(c, ctx) }))
      .sort((a, b) => Number(b.verdict.passed) - Number(a.verdict.passed) || b.verdict.score - a.verdict.score);
  }
}

// ── Safety policy verification (task policy is authoritative) ────────────────

export const SafetyVerdict = z.object({
  passed: z.boolean(),
  reason: z.string().optional(),
  category: z.string(),
});
export type SafetyVerdict = z.infer<typeof SafetyVerdict>;

interface CategoryRule {
  name: string;
  patterns: RegExp[];
  allowFlag: "allowDestructive" | "allowCredentialUse" | "allowExternalComms" | null;
  approvalKey: string;
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    name: "destructive",
    patterns: [/\brm\s+-rf\b/i, /\bformat\b/i, /\bdelete\b/i, /\bdrop\s+table\b/i, /\bshutdown\b/i,
      /\bwipe\b/i, /\bdestroy\b/i, /empty (trash|recycle)/i, /uninstall/i],
    allowFlag: "allowDestructive",
    approvalKey: "destructive",
  },
  {
    name: "credential",
    patterns: [/password/i, /secret/i, /\btoken\b/i, /api[_-]?key/i, /private[_-]?key/i, /sign[- ]?in/i,
      /login/i, /2fa|two[- ]factor|otp/i],
    allowFlag: "allowCredentialUse",
    approvalKey: "credential",
  },
  {
    name: "external-comms",
    patterns: [/\bemail\b/i, /\bsend\b/i, /\bupload\b/i, /\bpost\b/i, /\bshare\b/i, /\btweet\b/i,
      /\bpublish\b/i, /https?:\/\//i, /\bsms\b/i, /\bmessage\b/i],
    allowFlag: "allowExternalComms",
    approvalKey: "external-comms",
  },
  {
    name: "purchase",
    patterns: [/\bbuy\b/i, /purchase/i, /checkout/i, /pay\b/i, /payment/i, /order now/i, /subscribe/i],
    allowFlag: null,
    approvalKey: "purchase",
  },
  {
    name: "data-export",
    patterns: [/\bexport\b/i, /download/i, /\bscreenshot\b/i, /copy .*clipboard/i, /exfiltrat/i],
    allowFlag: null,
    approvalKey: "data-export",
  },
];

export class SafetyPolicyVerifier {
  check(taskInput: unknown, actionInput: unknown): SafetyVerdict {
    const task = TaskSpec.parse(taskInput);
    const action = ActionIR.parse(actionInput);
    const target = (action.target ?? {}) as { label?: unknown };
    // NOTE: key names are deliberately excluded: a lone "Delete" keypress is
    // ordinary editing, and key names cannot express destructive commands.
    const hay = `${action.intent ?? ""}\n${action.text ?? ""}\n${action.type}\n${typeof target.label === "string" ? target.label : ""}`;
    for (const rule of CATEGORY_RULES) {
      if (!rule.patterns.some((p) => p.test(hay))) continue;
      if (task.policy.requireApprovalFor.includes(rule.approvalKey)) {
        return {
          passed: false,
          category: rule.name,
          reason: `approval-required: action matches '${rule.name}' and task policy lists '${rule.approvalKey}' as requireApprovalFor`,
        };
      }
      if (rule.allowFlag && !task.policy[rule.allowFlag]) {
        return {
          passed: false,
          category: rule.name,
          reason: `approval-required: action matches '${rule.name}' but task policy sets ${rule.allowFlag}=false`,
        };
      }
      if (rule.allowFlag === null && rule.name === "purchase" && task.policy.requireApprovalFor.includes("purchase")) {
        return { passed: false, category: rule.name, reason: "approval-required: purchase actions always need approval" };
      }
    }
    return { passed: true, category: "benign" };
  }

  assertApproved(taskInput: unknown, actionInput: unknown): void {
    const v = this.check(taskInput, actionInput);
    if (!v.passed) throw new EveError("APPROVAL_REQUIRED", v.reason ?? "approval required");
  }
}

// ── Untrusted-content guard ──────────────────────────────────────────────────

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore\s+(all\s+)?previous\s+instructions/i, label: "ignore-previous-instructions" },
  { re: /disregard\s+(all\s+)?(prior|above|previous|system)/i, label: "disregard-prior" },
  { re: /you\s+are\s+now\b/i, label: "role-reassign" },
  { re: /system\s+prompt/i, label: "system-prompt-mention" },
  { re: /do\s+not\s+follow\s+(your|the)\s+(task|instructions)/i, label: "instruction-override" },
  { re: /new\s+instructions?:/i, label: "new-instructions" },
  { re: /override\s+(safety|policy|guardrail)/i, label: "override-safety" },
  { re: /jailbreak|DAN\s+mode/i, label: "jailbreak" },
];

export const InjectionScan = z.object({
  isInjection: z.boolean(),
  matched: z.array(z.string()),
});
export type InjectionScan = z.infer<typeof InjectionScan>;

/** On-screen text is untrusted data. Detect prompt-injection phrasing. */
export function scanUntrustedContent(screenTextInput: unknown): InjectionScan {
  const text = z.string().max(65536).parse(screenTextInput);
  const matched = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
  return { isInjection: matched.length > 0, matched };
}

export const PolicyWins = z.object({
  override: z.literal(false),
  reason: z.string(),
});
export type PolicyWins = z.infer<typeof PolicyWins>;

/**
 * On-screen instructions NEVER override task policy: the task wins, always.
 * Returns override:false with the rationale for the audit trail.
 */
export function enforceTaskPolicyWins(taskInput: unknown, screenTextInput: unknown): PolicyWins {
  const task = TaskSpec.parse(taskInput);
  const text = z.string().max(65536).parse(screenTextInput);
  const scan = scanUntrustedContent(text);
  const reason = scan.isInjection
    ? `Ignored on-screen injection (${scan.matched.join(", ")}); task ${task.taskId} policy remains authoritative.`
    : `No conflicting on-screen instructions; task ${task.taskId} policy applies.`;
  return { override: false as const, reason };
}
