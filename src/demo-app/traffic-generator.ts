import { Agent } from "agents";
import { runChainOnce } from "./chain";

const TICK_INTERVAL_SECONDS = 15;

export class TrafficGenerator extends Agent<Env> {
  async startTraffic(): Promise<{ started: boolean }> {
    const pending = this.getSchedules({ type: "delayed" });
    if (pending.length > 0) {
      return { started: false };
    }
    await this.schedule(TICK_INTERVAL_SECONDS, "tick");
    return { started: true };
  }

  async stopTraffic(): Promise<{ stopped: boolean }> {
    const pending = this.getSchedules({ type: "delayed" });
    for (const schedule of pending) {
      await this.cancelSchedule(schedule.id);
    }
    return { stopped: pending.length > 0 };
  }

  async tick(): Promise<void> {
    await runChainOnce(this.env);
    await this.schedule(TICK_INTERVAL_SECONDS, "tick");
  }
}
