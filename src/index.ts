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

// Manual trigger kept alongside the scheduled traffic-generator for one-off runs.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);

    if (url.pathname === "/debug/run-chain") {
      return Response.json(await runChainOnce(env));
    }

    if (request.method === "POST" && url.pathname === "/debug/tool") {
      const body = await request.json<{ name: string; input: unknown }>();
      return Response.json(await executeTool(body.name, body.input, env));
    }

    if (request.method === "POST" && url.pathname === "/admin/seed-baselines") {
      await seedBaselines(env);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/admin/seed-incident") {
      return Response.json(await seedIncident(env));
    }

    if (request.method === "POST" && url.pathname === "/admin/seed-outage") {
      return Response.json(await seedOutage(env));
    }

    if (request.method === "POST" && url.pathname === "/admin/seed-auth-incident") {
      return Response.json(await seedAuthIncident(env));
    }

    if (request.method === "POST" && url.pathname === "/admin/seed-checkout-incident") {
      return Response.json(await seedCheckoutIncident(env));
    }

    if (request.method === "POST" && url.pathname === "/admin/start-traffic") {
      const stub = await getAgentByName(env.TRAFFIC_GENERATOR, "singleton");
      return Response.json(await stub.startTraffic());
    }

    if (request.method === "POST" && url.pathname === "/admin/stop-traffic") {
      const stub = await getAgentByName(env.TRAFFIC_GENERATOR, "singleton");
      return Response.json(await stub.stopTraffic());
    }

    if (request.method === "POST" && url.pathname === "/admin/start-summaries") {
      const stub = await getAgentByName(env.SUMMARY_AGENT, "singleton");
      return Response.json(await stub.startSummaries());
    }

    if (request.method === "POST" && url.pathname === "/admin/stop-summaries") {
      const stub = await getAgentByName(env.SUMMARY_AGENT, "singleton");
      return Response.json(await stub.stopSummaries());
    }

    if (request.method === "POST" && url.pathname === "/admin/generate-summary") {
      const stub = await getAgentByName(env.SUMMARY_AGENT, "singleton");
      return Response.json(await stub.generateNow());
    }

    if (url.pathname === "/admin/summaries") {
      return Response.json(await getRecentSummaries(env.oncall_investigator_db, 10));
    }

    return new Response("oncall-investigator: not yet built", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
