import { Concept } from "../_components/Concept";

export default function KnowledgePage() {
  return (
    <>
      <h1>Knowledge base &amp; human handoff</h1>
      <p>
        Upload documents to an agent. Each one is split into chunks, embedded and stored in Postgres with pgvector.
        On every session message the best chunks are added to the agent&apos;s context, and the reply carries the
        documents it was drawn from. An agent labelled <code>handoff=human</code> can also pass a conversation to a
        person.
      </p>

      <Concept>
        The knowledge base is the agent&apos;s reference shelf: it looks things up before answering. Handoff is the
        &quot;let me get someone&quot; button: once pressed, the bot goes quiet and a human takes the chat.
      </Concept>

      <h2 id="documents">Documents</h2>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>POST</td><td><code>/v1/agents/{"{name}"}/documents</code></td><td>agents:write</td><td>Body <code>{"{title, content, source?, id?}"}</code>. Up to 1 MiB of text and 120 chunks. A caller-supplied <code>id</code> (UUID, unique per agent) makes the upload idempotent: the same id replaces the document. 201 with <code>chunkCount</code> and <code>embeddedChunks</code>.</td></tr>
          <tr><td>GET</td><td><code>/v1/agents/{"{name}"}/documents</code></td><td>agents:read</td><td>List.</td></tr>
          <tr><td>GET</td><td><code>/v1/agents/{"{name}"}/documents/{"{id}"}</code></td><td>agents:read</td><td>Metadata. 404 for another tenant&apos;s document.</td></tr>
          <tr><td>DELETE</td><td><code>/v1/agents/{"{name}"}/documents/{"{id}"}</code></td><td>agents:write</td><td>204; chunks are removed with it.</td></tr>
          <tr><td>POST</td><td><code>/v1/agents/{"{name}"}/documents/search</code></td><td>agents:read</td><td>Body <code>{"{query, limit?}"}</code>; returns <code>results[{"{documentId,title,content,score}"}]</code>.</td></tr>
        </tbody>
      </table>

      <h2 id="retrieval">How retrieval works</h2>
      <p>
        Chunks are embedded with the tenant&apos;s OpenAI key (<code>text-embedding-3-small</code>, 1536 dimensions)
        and matched by cosine distance; hits below <code>LANTERN_KB_MIN_SCORE</code> (default 0.2) are dropped. With no
        OpenAI key the chunks are stored without a vector and search falls back to Postgres full-text. The excerpts are
        fenced in the system prompt and labelled as reference data, not instructions. Agents with no documents pay
        nothing: no embedding call is made.
      </p>
      <p>
        The session event <code>message_completed</code> includes <code>sources: [{"{id, title}"}]</code> for the
        documents used; the web widget shows them under the reply.
      </p>

      <h2 id="handoff">Human handoff</h2>
      <p>
        Label the agent <code>handoff=human</code> (and optionally <code>handoff_slack_channel</code>). The agent then
        has exactly one tool, <code>handoff_to_human</code>, and no connector tools, so a public widget key cannot reach
        your integrations. When the model calls it the session moves to <code>status=handoff</code>, the stream emits{" "}
        <code>session.handoff</code>, and a message is posted to the Slack channel through your installed Slack
        connector (once per handoff).
      </p>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>POST</td><td><code>/v1/sessions/{"{id}"}/handoff</code></td><td>runs:execute</td><td>Force a handoff without the model. Idempotent.</td></tr>
          <tr><td>POST</td><td><code>/v1/sessions/{"{id}"}/operator-messages</code></td><td>write</td><td>Body <code>{"{content}"}</code>. Only while in handoff (409 otherwise); emits <code>operator.message</code>.</td></tr>
          <tr><td>POST</td><td><code>/v1/sessions/{"{id}"}/resolve</code></td><td>write</td><td>Hand the chat back to the agent; emits <code>session.resolved</code>.</td></tr>
          <tr><td>GET</td><td><code>/v1/sessions?status=handoff</code></td><td>read</td><td>The queue of conversations waiting for a person.</td></tr>
        </tbody>
      </table>
      <p>
        While a session is in handoff, customer messages are saved to the transcript and the model stays silent.
        Operator endpoints need the coarse <code>write</code> scope on purpose: a public widget key
        (<code>runs:execute</code>) must not be able to speak as the operator.
      </p>
    </>
  );
}
