import { agent, step } from "@lantern/sdk";

interface GreetingInput {
  name: string;
}

interface GreetingOutput {
  greeting: string;
}

export default agent<GreetingInput, GreetingOutput>({
  name: "hello-world",

  async run({ input, ctx }) {
    ctx.log.info("Starting hello-world agent", { name: input.name });

    const greeting = await step("generate-greeting", async () => {
      return ctx.llm.complete({
        prompt: `Generate a warm, creative greeting for someone named ${input.name}.
                 Keep it to 1-2 sentences.`,
        capability: "chat-small",
        optimize: "cheap",
      });
    });

    ctx.log.info("Greeting generated", { greeting });

    return { greeting };
  },
});
