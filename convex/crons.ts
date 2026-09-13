import { cronJobs } from "convex/server";
import { registerCostLedgerCron } from "./costLedgerCron";
const crons = cronJobs();
registerCostLedgerCron(crons);
export default crons;
