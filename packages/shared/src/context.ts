import { localDay } from "./index"
import { validExperimentDay, type Adherence } from "./experiments"

export const contextTopics = {
  work_demands: ["Demanding work", "Unusually demanding work or deadline pressure", "Were work demands unusual that day?"],
  evening_work: ["Evening work", "Work during the evening or night", "Did you work in the evening or at night?"],
  travel: ["Travel", "Travel actually occurring, not merely visiting an airport or planning travel", "Did you travel that day, or was travel only planned?"],
  routine_disruption: ["Routine change", "An explicitly described departure from the person's usual routine", "Was anything different from your usual routine?"],
  caffeine: ["Caffeine", "Consumption of caffeine; coffee or tea of unspecified type is ambiguous, and one decaf drink does not establish no caffeine for the day", "Did you have any caffeine that day? If so, when?"],
  late_meal: ["Late meal", "A meal explicitly described as late or close to bedtime", "Was your last meal late or close to bedtime?"],
  exercise: ["Exercise", "A workout or intentional exercise, as self-reported rather than measured by a device", "Did you do intentional exercise that day?"],
  recovery_activity: ["Recovery activity", "Deliberate relaxation such as meditation, stretching or breathing exercises", "Did you make time for relaxation, stretching or meditation?"],
  sleep_disruption: ["Sleep interruption", "A reported external sleep interruption such as noise, an unfamiliar bed, or caregiving", "Was your sleep interrupted by noise, caregiving or your surroundings?"],
  social_event: ["Social gathering", "Participation in a social gathering", "Did you attend a social gathering that day?"],
  adderall: ["Adderall", "Reported taking of Adderall; no dose, formulation or prescribed schedule may be inferred", "Did you take Adderall that day? You can skip this question."],
  zepbound: ["Zepbound", "Reported taking of Zepbound; no dose or prescribed schedule may be inferred", "Did you take Zepbound that day? You can skip this question."]
} as const
export type ContextTopic = keyof typeof contextTopics
export const contextLabels = ["present", "absent", "unknown", "conflicting"] as const
export type ContextLabel = typeof contextLabels[number]
export type ChoiceAnswer<T extends string> = { type: "choice"; choice: T; confidence: number; probabilities: Record<T, number> }
export type ContextLabels = Record<ContextTopic, ContextLabel>
export type ContextProposal = {
  id: string; provider: "cloudflare"; requestedModel: string; model: string; rubricVersion: string;
  sourceHash: string; createdAt: string; reviewRequired: true; scope: "stated_period_only";
  answers: Record<ContextTopic, ChoiceAnswer<ContextLabel>>;
  usage: { input_tokens: number; output_tokens: number }; estimatedInputCostUsd: number;
  followUps: ContextTopic[]; input: { note: string; responses: Partial<Record<ContextTopic, string>> };
  experiment?: { id: string; version: number }; adherence?: ChoiceAnswer<Adherence>;
}
export type ContextRevision = { day: string; version: number; savedAt: string; proposal: ContextProposal; labels: ContextLabels; reason: string }
export const proposedLabels = (p: ContextProposal): ContextLabels => Object.fromEntries(Object.entries(p.answers).map(([k, a]) => [k, a.choice])) as ContextLabels

export function validateContextSave(value: unknown): { version: number; proposalId: string; labels: ContextLabels; reason: string } {
  const v = value as ReturnType<typeof validateContextSave>
  if (!v || !Number.isSafeInteger(v.version) || v.version < 0 || typeof v.proposalId !== "string" || !/^[a-f0-9-]{36}$/.test(v.proposalId) ||
    typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 500 || !v.labels ||
    Object.keys(v.labels).length !== Object.keys(contextTopics).length ||
    !Object.keys(contextTopics).every(k => contextLabels.includes(v.labels[k as ContextTopic]))) throw new Error("Review every topic and add a revision reason (up to 500 characters).")
  return { version: v.version, proposalId: v.proposalId, labels: v.labels, reason: v.reason }
}
export const validContextDay = (day: string) => validExperimentDay(day) && day <= localDay(new Date())

// Fixed, outcome-blind priority. Model labels inform selection; the model never writes questions.
export function selectFollowUps(answers: ContextProposal["answers"], answered: string[], medications: boolean): ContextTopic[] {
  const topics = (Object.keys(contextTopics) as ContextTopic[]).filter(k => !answered.includes(k) && (medications || !["adderall", "zepbound"].includes(k)))
  const priority = (k: ContextTopic) => answers[k].choice === "conflicting" ? 0 : answers[k].confidence < 0.7 ? 1 : answers[k].choice === "unknown" ? 2 : 3
  return topics.filter(k => priority(k) < 3).sort((a, b) => priority(a) - priority(b)).slice(0, Math.max(0, 2 - answered.length))
}
