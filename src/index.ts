import { getAgentByName, routeAgentRequest } from "agents";
import { Investigator } from "./agent/investigator";
import { SummaryAgent } from "./agent/summary-agent";
import { executeTool } from "./agent/tools";
import { runChainOnce } from "./demo-app/chain";
import { seedAuthIncident } from "./demo-app/seed-auth-incident";
import { seedBaselines } from "./demo-app/seed-baselines";
import { seedCheckoutIncident } from "./demo-app/seed-checkout-incident";
import { seedIncident } from "./demo-app/seed-incident";
import { seedOutage } from "./demo-app/seed-outage";
import { TrafficGenerator } from "./demo-app/traffic-generator";
import { getRecentSummaries } from "./storage/summaries";

export { Investigator, SummaryAgent, TrafficGenerator };

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

const routes: Record<string, RouteHandler> = {
  // Manual trigger kept alongside the scheduled traffic generator for one-off runs.
  "POST /debug/run-chain": async (_request, env) => Response.json(await runChainOnce(env)),

  "POST /debug/tool": async (request, env) => {
    const body = await request.json<{ name: string; input: unknown }>();
    return Response.json(await executeTool(body.name, body.input, env));
  },

  "POST /admin/seed-baselines": async (_request, env) => {
    await seedBaselines(env);
    return Response.json({ ok: true });
  },

  "POST /admin/seed-incident": async (_request, env) => Response.json(await seedIncident(env)),
  "POST /admin/seed-outage": async (_request, env) => Response.json(await seedOutage(env)),
  "POST /admin/seed-auth-incident": async (_request, env) => Response.json(await seedAuthIncident(env)),
  "POST /admin/seed-checkout-incident": async (_request, env) => Response.json(await seedCheckoutIncident(env)),

  "POST /admin/start-traffic": async (_request, env) => {
    const stub = await getAgentByName(env.TRAFFIC_GENERATOR, "singleton");
    return Response.json(await stub.startTraffic());
  },

  "POST /admin/stop-traffic": async (_request, env) => {
    const stub = await getAgentByName(env.TRAFFIC_GENERATOR, "singleton");
    return Response.json(await stub.stopTraffic());
  },

  "POST /admin/start-summaries": async (_request, env) => {
    const stub = await getAgentByName(env.SUMMARY_AGENT, "singleton");
    return Response.json(await stub.startSummaries());
  },

  "POST /admin/stop-summaries": async (_request, env) => {
    const stub = await getAgentByName(env.SUMMARY_AGENT, "singleton");
    return Response.json(await stub.stopSummaries());
  },

  "POST /admin/generate-summary": async (_request, env) => {
    const stub = await getAgentByName(env.SUMMARY_AGENT, "singleton");
    return Response.json(await stub.generateNow());
  },

  "GET /admin/summaries": async (_request, env) =>
    Response.json(await getRecentSummaries(env.oncall_investigator_db, 10)),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (handler) return handler(request, env);

    return new Response("oncall-investigator: not yet built", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
