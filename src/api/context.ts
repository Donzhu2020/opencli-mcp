/** What every object of the model carries: the runtime, the MCP session id, and that session's state. */
import type { Runtime, SessionState } from '../runtime/runtime.js';

export interface SessionContext { rt: Runtime; sessionId: string; state: SessionState }
