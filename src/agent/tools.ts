import type Anthropic from "@anthropic-ai/sdk";
import { getBaseline } from "../storage/baseline";
import { getDeploys } from "../storage/deploys";
import { getLogs, listServices } from "../storage/logs";
import { queryMetrics } from "../storage/metrics";

const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 50;
const MAX_WINDOW_MINUTES = 1440;
const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: "list_services",
    description:
      "List all services that have logged activity. Call this first to orient before investigating — it tells you what services exist to investigate.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_logs",
    description:
      "Get aggregated log counts and a capped sample of raw log rows for a service within a time range. Counts are grouped by level/status/error type over the full range; samples are capped and prioritize error rows.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. 'payment-service'" },
        since: { type: "integer", description: "Start of range, unix ms" },
        until: { type: "integer", description: "End of range, unix ms" },
        level: { type: "string", enum: ["info", "error"], description: "Optional level filter" },
        limit: {
          type: "integer",
          description: `Max sample rows to return (default ${DEFAULT_LOG_LIMIT}, capped at ${MAX_LOG_LIMIT})`,
        },
      },
      required: ["service", "since", "until"],
    },
  },
  {
    name: "get_deploys",
    description: "Get the deploy timeline for a service since a given time.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        since: { type: "integer", description: "unix ms" },
      },
      required: ["service", "since"],
    },
  },
  {
    name: "get_baseline",
    description:
      "Get the known-normal latency and error rate ranges for a service, to compare against current behavior.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
      },
      required: ["service"],
    },
  },
  {
    name: "get_metrics",
    description:
      "Get p50/p95/p99 latency, error rate, and request count for a service over a recent time window.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. 'payment-service'" },
        window_minutes: {
          type: "integer",
          description: `How many minutes back to look, from now (max ${MAX_WINDOW_MINUTES})`,
        },
      },
      required: ["service", "window_minutes"],
    },
  },
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function listServicesTool(env: Env): Promise<{ services: string[] }> {
  const services = await listServices(env.oncall_investigator_db);
  return { services };
}

interface GetLogsInput {
  service?: unknown;
  since?: unknown;
  until?: unknown;
  level?: unknown;
  limit?: unknown;
}

async function getLogsTool(env: Env, input: GetLogsInput) {
  const { service, since, until, level, limit } = input;

  if (!isNonEmptyString(service)) return { error: "service must be a non-empty string" };
  if (!isFiniteNumber(since)) return { error: "since must be a unix-ms number" };
  if (!isFiniteNumber(until)) return { error: "until must be a unix-ms number" };
  if (since >= until) return { error: "since must be before until" };
  if (level !== undefined && level !== "info" && level !== "error") {
    return { error: "level must be 'info' or 'error'" };
  }

  const requestedLimit = isFiniteNumber(limit) ? limit : DEFAULT_LOG_LIMIT;
  const cappedLimit = Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_LOG_LIMIT);

  return getLogs(env.oncall_investigator_db, {
    service,
    since,
    until,
    level: level as "info" | "error" | undefined,
    limit: cappedLimit,
  });
}

interface GetDeploysInput {
  service?: unknown;
  since?: unknown;
}

async function getDeploysTool(env: Env, input: GetDeploysInput) {
  const { service, since } = input;
  if (!isNonEmptyString(service)) return { error: "service must be a non-empty string" };
  if (!isFiniteNumber(since)) return { error: "since must be a unix-ms number" };

  const deploys = await getDeploys(env.KV, service, since);
  return { deploys };
}

interface GetBaselineInput {
  service?: unknown;
}

async function getBaselineTool(env: Env, input: GetBaselineInput) {
  const { service } = input;
  if (!isNonEmptyString(service)) return { error: "service must be a non-empty string" };

  const baseline = await getBaseline(env.KV, service);
  if (!baseline) return { error: `no baseline seeded for ${service}` };
  return baseline;
}

interface GetMetricsInput {
  service?: unknown;
  window_minutes?: unknown;
}

async function getMetricsTool(env: Env, input: GetMetricsInput) {
  const { service, window_minutes: windowMinutes } = input;

  if (!isNonEmptyString(service) || !SERVICE_NAME_PATTERN.test(service)) {
    return { error: "service must be a non-empty alphanumeric/dash string" };
  }
  if (!isFiniteNumber(windowMinutes) || !Number.isInteger(windowMinutes) || windowMinutes <= 0) {
    return { error: "window_minutes must be a positive integer" };
  }

  const cappedWindow = Math.min(windowMinutes, MAX_WINDOW_MINUTES);
  const result = await queryMetrics(env, service, cappedWindow);

  if (!result) {
    return { service, windowMinutes: cappedWindow, note: "no data for this range" };
  }

  return { service, windowMinutes: cappedWindow, ...result };
}

export async function executeTool(name: string, input: unknown, env: Env): Promise<unknown> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_services":
        return await listServicesTool(env);
      case "get_logs":
        return await getLogsTool(env, args);
      case "get_deploys":
        return await getDeploysTool(env, args);
      case "get_baseline":
        return await getBaselineTool(env, args);
      case "get_metrics":
        return await getMetricsTool(env, args);
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
