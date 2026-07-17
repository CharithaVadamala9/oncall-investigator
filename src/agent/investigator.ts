import { Agent, type Connection } from "agents";

// Skeleton: proves the WebSocket plumbing works. The Anthropic tool loop
// replaces onMessage's echo in Phase 8.
export class Investigator extends Agent<Env> {
  onConnect(connection: Connection): void {
    connection.send(JSON.stringify({ type: "info", message: "connected" }));
  }

  onMessage(connection: Connection, message: string): void {
    connection.send(JSON.stringify({ type: "echo", message }));
  }
}
