export interface DeployEvent {
  timestamp: number;
  version: string;
  description: string;
}

function key(service: string): string {
  return `deploy:${service}`;
}

async function getAllDeploys(kv: KVNamespace, service: string): Promise<DeployEvent[]> {
  const raw = await kv.get(key(service));
  return raw ? JSON.parse(raw) : [];
}

export async function addDeploy(kv: KVNamespace, service: string, event: DeployEvent): Promise<void> {
  const events = await getAllDeploys(kv, service);
  events.push(event);
  events.sort((a, b) => a.timestamp - b.timestamp);
  await kv.put(key(service), JSON.stringify(events));
}

export async function getDeploys(kv: KVNamespace, service: string, since: number): Promise<DeployEvent[]> {
  const events = await getAllDeploys(kv, service);
  return events.filter((event) => event.timestamp >= since);
}
