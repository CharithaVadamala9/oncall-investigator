import { getAgentByName, routeAgentRequest } from "agents";
import { Investigator } from "./agent/investigator";
import { executeTool } from "./agent/tools";
import { runChainOnce } from "./demo-app/chain";
import { seedAuthIncident } from "./demo-app/seed-auth-incident";
import { seedBaselines } from "./demo-app/seed-baselines";
import { seedIncident } from "./demo-app/seed-incident";
import { seedOutage } from "./demo-app/seed-outage";
import { TrafficGenerator } from "./demo-app/traffic-generator";

export { Investigator, TrafficGenerator };

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

    if (request.method === "POST" && url.pathname === "/admin/start-traffic") {
      const stub = await getAgentByName(env.TRAFFIC_GENERATOR, "singleton");
      return Response.json(await stub.startTraffic());
    }

    if (request.method === "POST" && url.pathname === "/admin/stop-traffic") {
      const stub = await getAgentByName(env.TRAFFIC_GENERATOR, "singleton");
      return Response.json(await stub.stopTraffic());
    }

    return new Response("oncall-investigator: not yet built", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
