import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "agents";
import { searchIncidents } from "../storage/incidents";
import { recordSummary } from "../storage/summaries";

// 5 minutes stands in for "weekly" at demo speed — same move as the
// traffic generator's 15s interval standing in for continuous production
// traffic. A real deployment would use a much longer interval or a cron
// schedule string instead of a plain delay.
const TICK_INTERVAL_SECONDS = 5 * 60;
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
const MAX_INCIDENTS_TO_SUMMARIZE = 20;

export interface SummaryResult {
  incidentCount: number;
  summary: string;
}

// Plain summarization, not the investigator's tool loop — this is reading
// already-recorded text and condensing it, not investigating anything.
async function buildSummary(env: Env): Promise<SummaryResult> {
  const incidents = await searchIncidents(env.oncall_investigator_db, { limit: MAX_INCIDENTS_TO_SUMMARIZE });

  if (incidents.length === 0) {
    return { incidentCount: 0, summary: "No investigations recorded in this period." };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const report = incidents
    .map((incident, i) => `${i + 1}. Symptom: ${incident.symptom}\nResolution: ${incident.summary}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: `Summarize these ${incidents.length} on-call investigations from the past period into a short digest for a team: common themes, which services were most affected, and anything recurring that suggests a systemic issue rather than a one-off.\n\n${report}`,
      },
    ],
  });

  const summary = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return { incidentCount: incidents.length, summary };
}

export class SummaryAgent extends Agent<Env> {
  async startSummaries(): Promise<{ started: boolean }> {
    const pending = this.getSchedules({ type: "delayed" });
    if (pending.length > 0) {
      return { started: false };
    }
    await this.schedule(TICK_INTERVAL_SECONDS, "tick");
    return { started: true };
  }

  async stopSummaries(): Promise<{ stopped: boolean }> {
    const pending = this.getSchedules({ type: "delayed" });
    for (const schedule of pending) {
      await this.cancelSchedule(schedule.id);
    }
    return { stopped: pending.length > 0 };
  }

  async tick(): Promise<void> {
    const result = await buildSummary(this.env);
    await recordSummary(this.env.oncall_investigator_db, { timestamp: Date.now(), ...result });
    await this.schedule(TICK_INTERVAL_SECONDS, "tick");
  }

  // Manual trigger for testing/demo — doesn't touch the schedule, just
  // runs the same summarization logic on demand.
  async generateNow(): Promise<SummaryResult> {
    const result = await buildSummary(this.env);
    await recordSummary(this.env.oncall_investigator_db, { timestamp: Date.now(), ...result });
    return result;
  }
}
