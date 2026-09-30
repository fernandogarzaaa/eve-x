import { z } from "zod";
import { EveError, nowIso } from "../../core/src/index.js";

// ── Report builder: one input → HTML + Markdown + JSON.
// Sections: exec summary, outcome, findings w/ evidence, screenshots, trace,
// expectation violations, judgments, agreement, timeline, latency,
// trust/emotion/load, versions, replay ref. ──

const FindingInputSchema = z.object({
  dimension: z.string().min(1),
  claim: z.string().min(1),
  evidenceStepIds: z.array(z.string().min(1)).min(1),
  score: z.number().min(0).max(100),
  severity: z.enum(["info", "minor", "major", "critical"]).default("info"),
  detail: z.string().max(4096).optional(),
});
export type ReportFinding = z.infer<typeof FindingInputSchema>;

export const ReportInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  goal: z.string().min(1).max(2048),
  outcome: z.string().min(1).max(1024),
  success: z.boolean(),
  executiveSummary: z.string().min(1).max(4096),
  findings: z.array(FindingInputSchema).min(1),
  screenshotRefs: z.array(z.object({ stepId: z.string().min(1), ref: z.string().min(1), caption: z.string().max(512).default("") })).default([]),
  traceDigest: z.string().min(1),
  traceStepCount: z.number().int().min(0),
  expectationViolations: z.array(z.object({ stepId: z.string(), prediction: z.string(), actual: z.string() })).default([]),
  judgments: z.array(z.object({ stepId: z.string(), reviewer: z.string(), reasonable: z.boolean(), note: z.string().optional() })).default([]),
  agreement: z.array(z.object({ stepId: z.string(), pairwiseAgreement: z.number().min(0).max(1), n: z.number().int().min(0) })).default([]),
  timeline: z.array(z.object({ seq: z.number().int().min(0), stepId: z.string(), outcome: z.string().optional(), latencyMs: z.number().optional() })).default([]),
  latency: z.object({ p50Ms: z.number().min(0), p95Ms: z.number().min(0), samples: z.number().int().min(0) }),
  affective: z.object({
    trustMean: z.number().min(0).max(1),
    trustSeries: z.array(z.number().min(0).max(1)),
    emotionLabels: z.array(z.string()),
    loadMean: z.number().min(0).max(1),
  }),
  versions: z.object({ model: z.string().min(1), environment: z.string().min(1), codeHash: z.string().min(1), protocol: z.string().min(1).default("1.0.0") }),
  replayRef: z.string().min(1),
});
export type ReportInput = z.infer<typeof ReportInputSchema>;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}

function severityBadge(sev: string): string {
  const color = sev === "critical" ? "#b91c1c" : sev === "major" ? "#c2410c" : sev === "minor" ? "#a16207" : "#166534";
  return `<span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;color:#fff;background:${color}">${escHtml(sev)}</span>`;
}

export class ReportBuilder {
  private input: ReportInput;

  constructor(raw: unknown) {
    this.input = ReportInputSchema.parse(raw);
  }

  overallScore(): number {
    const scores = this.input.findings.map((f) => f.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.round(mean * 10) / 10;
  }

  buildJson(): Record<string, unknown> {
    const i = this.input;
    return {
      kind: "eve-x-experience-report",
      sessionId: i.sessionId,
      taskId: i.taskId,
      goal: i.goal,
      outcome: i.outcome,
      success: i.success,
      overallScore: this.overallScore(),
      executiveSummary: i.executiveSummary,
      findings: i.findings,
      screenshotRefs: i.screenshotRefs,
      trace: { digest: i.traceDigest, stepCount: i.traceStepCount },
      expectationViolations: i.expectationViolations,
      judgments: i.judgments,
      agreement: i.agreement,
      timeline: i.timeline,
      latency: i.latency,
      affective: i.affective,
      versions: i.versions,
      replayRef: i.replayRef,
      builtAt: nowIso(),
    };
  }

  buildMarkdown(): string {
    const i = this.input;
    const L: string[] = [];
    L.push(`# EVE-X Experience Report — ${escMd(i.sessionId)}`);
    L.push("");
    L.push(`**Task:** ${escMd(i.taskId)} · **Outcome:** ${i.success ? "SUCCESS" : "NOT ACHIEVED"} · **Overall:** ${this.overallScore()}/100`);
    L.push("");
    L.push("## Executive summary");
    L.push("");
    L.push(escMd(i.executiveSummary));
    L.push("");
    L.push("## Outcome");
    L.push("");
    L.push(`Goal: ${escMd(i.goal)}`);
    L.push("");
    L.push(`Result: ${escMd(i.outcome)}`);
    L.push("");
    L.push("## Findings (evidence-linked)");
    L.push("");
    L.push("| Dimension | Score | Severity | Claim | Evidence |");
    L.push("| --- | ---: | --- | --- | --- |");
    for (const f of i.findings) {
      L.push(`| ${escMd(f.dimension)} | ${f.score} | ${f.severity} | ${escMd(f.claim)} | ${f.evidenceStepIds.map((s) => `\`${escMd(s)}\``).join(", ")} |`);
    }
    L.push("");
    if (i.expectationViolations.length > 0) {
      L.push("## Expectation violations");
      L.push("");
      for (const v of i.expectationViolations) {
        L.push(`- step \`${escMd(v.stepId)}\`: predicted "${escMd(v.prediction)}" but observed "${escMd(v.actual)}"`);
      }
      L.push("");
    }
    if (i.judgments.length > 0) {
      L.push("## Human judgments");
      L.push("");
      for (const j of i.judgments) {
        L.push(`- ${escMd(j.reviewer)} on \`${escMd(j.stepId)}\`: ${j.reasonable ? "reasonable" : "FLAGGED"}${j.note ? ` — ${escMd(j.note)}` : ""}`);
      }
      L.push("");
    }
    if (i.agreement.length > 0) {
      L.push("## Reviewer agreement");
      L.push("");
      for (const a of i.agreement) {
        L.push(`- \`${escMd(a.stepId)}\`: pairwise ${Math.round(a.pairwiseAgreement * 100)}% (n=${a.n})`);
      }
      L.push("");
    }
    L.push("## Timeline & latency");
    L.push("");
    L.push(`Steps: ${i.traceStepCount} · p50 ${i.latency.p50Ms}ms · p95 ${i.latency.p95Ms}ms (${i.latency.samples} samples) · trace \`${escMd(i.traceDigest)}\``);
    L.push("");
    for (const t of i.timeline.slice(0, 60)) {
      L.push(`- seq ${t.seq} \`${escMd(t.stepId)}\`${t.outcome ? ` — ${escMd(t.outcome).slice(0, 120)}` : ""}${t.latencyMs !== undefined ? ` (${t.latencyMs}ms)` : ""}`);
    }
    L.push("");
    L.push("## Trust / emotion / load");
    L.push("");
    L.push(`Trust mean ${i.affective.trustMean.toFixed(2)} · load mean ${i.affective.loadMean.toFixed(2)} · emotions: ${i.affective.emotionLabels.map(escMd).join(", ") || "n/a"}`);
    L.push("");
    if (i.screenshotRefs.length > 0) {
      L.push("## Screenshots");
      L.push("");
      for (const s of i.screenshotRefs) {
        L.push(`- \`${escMd(s.stepId)}\`: ${escMd(s.ref)}${s.caption ? ` — ${escMd(s.caption)}` : ""}`);
      }
      L.push("");
    }
    L.push("## Versions & replay");
    L.push("");
    L.push(`Model ${escMd(i.versions.model)} · env ${escMd(i.versions.environment)} · code ${escMd(i.versions.codeHash)} · protocol ${escMd(i.versions.protocol)} · replay \`${escMd(i.replayRef)}\``);
    L.push("");
    return L.join("\n");
  }

  buildHtml(): string {
    const i = this.input;
    const findingRows = i.findings
      .map(
        (f) =>
          `<tr><td>${escHtml(f.dimension)}</td><td style="text-align:right">${f.score}</td><td>${severityBadge(f.severity)}</td>` +
          `<td>${escHtml(f.claim)}${f.detail ? `<br><small>${escHtml(f.detail)}</small>` : ""}</td>` +
          `<td>${f.evidenceStepIds.map((s) => `<code>${escHtml(s)}</code>`).join(" ")}</td></tr>`,
      )
      .join("\n");
    const timelineItems = i.timeline
      .slice(0, 80)
      .map((t) => `<li>seq ${t.seq} <code>${escHtml(t.stepId)}</code>${t.outcome ? ` — ${escHtml(t.outcome.slice(0, 140))}` : ""}</li>`)
      .join("\n");
    const shots =
      i.screenshotRefs.length > 0
        ? `<h2>Screenshots</h2><ul>${i.screenshotRefs.map((s) => `<li><code>${escHtml(s.stepId)}</code>: ${escHtml(s.ref)}${s.caption ? ` — ${escHtml(s.caption)}` : ""}</li>`).join("")}</ul>`
        : "";
    const violations =
      i.expectationViolations.length > 0
        ? `<h2>Expectation violations</h2><ul>${i.expectationViolations.map((v) => `<li><code>${escHtml(v.stepId)}</code>: predicted &ldquo;${escHtml(v.prediction)}&rdquo; but observed &ldquo;${escHtml(v.actual)}&rdquo;</li>`).join("")}</ul>`
        : "";
    const judgments =
      i.judgments.length > 0
        ? `<h2>Human judgments</h2><ul>${i.judgments.map((j) => `<li>${escHtml(j.reviewer)} on <code>${escHtml(j.stepId)}</code>: ${j.reasonable ? "reasonable" : "<strong>flagged</strong>"}${j.note ? ` — ${escHtml(j.note)}` : ""}</li>`).join("")}</ul>`
        : "";
    const agreement =
      i.agreement.length > 0
        ? `<h2>Reviewer agreement</h2><ul>${i.agreement.map((a) => `<li><code>${escHtml(a.stepId)}</code>: ${Math.round(a.pairwiseAgreement * 100)}% pairwise (n=${a.n})</li>`).join("")}</ul>`
        : "";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EVE-X report ${escHtml(i.sessionId)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:14px}th{background:#f3f4f6}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}.pill{display:inline-block;padding:2px 10px;border-radius:999px;color:#fff;font-size:12px}</style>
</head><body>
<p><span class="pill" style="background:${i.success ? "#166534" : "#b91c1c"}">${i.success ? "SUCCESS" : "NOT ACHIEVED"}</span> <strong>${this.overallScore()}/100</strong></p>
<h1>EVE-X Experience Report — ${escHtml(i.sessionId)}</h1>
<p>Task <code>${escHtml(i.taskId)}</code> · goal: ${escHtml(i.goal)}</p>
<h2>Executive summary</h2><p>${escHtml(i.executiveSummary)}</p>
<h2>Outcome</h2><p>${escHtml(i.outcome)}</p>
<h2>Findings (evidence-linked)</h2>
<table><thead><tr><th>Dimension</th><th>Score</th><th>Severity</th><th>Claim</th><th>Evidence</th></tr></thead><tbody>${findingRows}</tbody></table>
${violations}${judgments}${agreement}
<h2>Timeline &amp; latency</h2>
<p>${i.traceStepCount} steps · p50 ${i.latency.p50Ms}ms · p95 ${i.latency.p95Ms}ms · trace <code>${escHtml(i.traceDigest)}</code></p>
<ol>${timelineItems}</ol>
<h2>Trust / emotion / load</h2>
<p>Trust mean ${i.affective.trustMean.toFixed(2)} · load mean ${i.affective.loadMean.toFixed(2)} · emotions: ${i.affective.emotionLabels.map(escHtml).join(", ") || "n/a"}</p>
${shots}
<h2>Versions &amp; replay</h2>
<p>Model ${escHtml(i.versions.model)} · env ${escHtml(i.versions.environment)} · code ${escHtml(i.versions.codeHash)} · protocol ${escHtml(i.versions.protocol)} · replay <code>${escHtml(i.replayRef)}</code></p>
</body></html>`;
  }

  buildAll(): { json: Record<string, unknown>; markdown: string; html: string } {
    if (this.input.findings.length === 0) throw new EveError("NO_FINDINGS", "Report requires at least one evidence-linked finding");
    return { json: this.buildJson(), markdown: this.buildMarkdown(), html: this.buildHtml() };
  }
}
