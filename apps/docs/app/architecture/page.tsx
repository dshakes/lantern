import { ArchitectureExplorer } from "../_components/interactive/ArchitectureExplorer";
import { LifecycleMachine } from "../_components/interactive/LifecycleMachine";
import { Sequence } from "../_components/interactive/Sequence";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/architecture");

export default function ArchitecturePage() {
  return (
    <>
      <h1>Architecture explorer</h1>
      <p>
        Every box below is a real process and every arrow a real call. Select one to see what it does, the port it
        listens on, the trust boundary it enforces, and the source lines that back the claim. The runtime manager and the
        harness open into component views.
      </p>

      <h2 id="map">System map</h2>
      <ArchitectureExplorer />

      <h2 id="sequences">Sequences</h2>
      <p>Step through each one, or press play. Scenario buttons switch to the failure and refusal paths.</p>
      <Sequence name="run" />
      <Sequence name="tool" />
      <Sequence name="egress" />
      <Sequence name="lifecycle" />

      <h2 id="lifecycle">Sandbox states</h2>
      <LifecycleMachine />
    </>
  );
}
