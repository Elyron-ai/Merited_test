// @merited/demo — the demo-as-E2E toolkit (§8/§10). The harness lands with
// VAL-11; the Act 1 step list (VAL-12/13) builds on it.
export {
  runAct,
  StepFailedError,
  type ActResult,
  type DemoMode,
  type DemoStep,
  type RunActOptions,
  type StepContext,
} from './harness.js';
export { act1Steps, runAct1, type Act1Handles, type RunAct1Options } from './act1.js';
